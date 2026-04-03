#!/usr/bin/env node
import * as p from '@clack/prompts';
import { readSettings, requireSettings, writeSettings, unwrap } from './shared.ts';
import { resolveModel } from '@tinyagi/core';

// --- models list ---

function modelsList() {
    const settings = requireSettings();
    const agents = settings.agents || {};
    const agentIds = Object.keys(agents);

    if (agentIds.length === 0) {
        p.log.warning('No agents configured.');
        return;
    }

    p.log.message('');
    p.log.message('Agent models:');
    for (const id of agentIds) {
        const agent = agents[id];
        const resolved = resolveModel(agent.model, agent.provider);
        const display = resolved !== agent.model
            ? `${agent.provider}/${agent.model} → ${resolved}`
            : `${agent.provider}/${agent.model}`;
        p.log.message(`  @${id}: ${display}`);
    }

    // Show custom providers
    const custom = settings.custom_providers || {};
    const customIds = Object.keys(custom);
    if (customIds.length > 0) {
        p.log.message('');
        p.log.message('Custom providers:');
        for (const id of customIds) {
            const cp = custom[id];
            p.log.message(`  ${id}: ${cp.base_url} (harness: ${cp.harness}${cp.model ? ', model: ' + cp.model : ''})`);
        }
    }
}

// --- models browse ---

interface OpenRouterModel {
    id: string;
    name: string;
    context_length: number;
    pricing: {
        prompt: string;
        completion: string;
    };
    description?: string;
}

async function modelsBrowse(filterArg?: string) {
    const settings = requireSettings();
    const apiKey = settings.custom_providers?.openrouter?.api_key;

    const spinner = p.spinner();
    spinner.start('Fetching models from OpenRouter...');

    let models: OpenRouterModel[];
    try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (apiKey && apiKey !== 'YOUR_OPENROUTER_API_KEY') {
            headers['Authorization'] = `Bearer ${apiKey}`;
        }

        const res = await fetch('https://openrouter.ai/api/v1/models', { headers });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
        const data = await res.json() as { data: OpenRouterModel[] };
        models = data.data || [];
    } catch (err: any) {
        spinner.stop('Failed to fetch models');
        p.log.error(err.message);
        return;
    }

    // Filter out non-chat models
    models = models.filter(m =>
        !m.id.includes(':free') ||
        m.id.includes('/') // keep provider-prefixed models
    );

    // Sort by name
    models.sort((a, b) => a.id.localeCompare(b.id));

    spinner.stop(`Found ${models.length} models`);

    // Extract unique providers for filtering
    const providers = [...new Set(models.map(m => m.id.split('/')[0]))].sort();

    // Apply text filter if provided
    let filtered = models;
    if (filterArg) {
        const q = filterArg.toLowerCase();
        filtered = models.filter(m =>
            m.id.toLowerCase().includes(q) ||
            m.name.toLowerCase().includes(q)
        );
        p.log.info(`Showing ${filtered.length} models matching "${filterArg}"`);
    }

    // Provider filter
    if (!filterArg) {
        const providerChoice = unwrap(await p.select({
            message: 'Filter by provider (or show all)',
            options: [
                { value: '__all__', label: `All providers (${models.length} models)` },
                ...providers.map(pr => ({
                    value: pr,
                    label: `${pr} (${models.filter(m => m.id.startsWith(pr + '/')).length})`,
                })),
            ],
        }));

        if (providerChoice !== '__all__') {
            filtered = models.filter(m => m.id.startsWith(providerChoice + '/'));
        }
    }

    if (filtered.length === 0) {
        p.log.warning('No models found matching your criteria.');
        return;
    }

    // Format pricing helper
    const fmtPrice = (perToken: string): string => {
        const val = parseFloat(perToken);
        if (isNaN(val) || val === 0) return 'free';
        const perMillion = val * 1_000_000;
        return `$${perMillion.toFixed(2)}/1M`;
    };

    // Format context length
    const fmtCtx = (ctx: number): string => {
        if (ctx >= 1_000_000) return `${(ctx / 1_000_000).toFixed(1)}M`;
        if (ctx >= 1000) return `${Math.round(ctx / 1000)}k`;
        return `${ctx}`;
    };

    // Build options — show up to 50 at a time
    const pageSize = 50;
    const pages = Math.ceil(filtered.length / pageSize);
    let page = 0;

    while (true) {
        const start = page * pageSize;
        const end = Math.min(start + pageSize, filtered.length);
        const pageModels = filtered.slice(start, end);

        const options: { value: string; label: string; hint: string }[] = pageModels.map(m => ({
            value: m.id,
            label: m.id,
            hint: `ctx: ${fmtCtx(m.context_length)} | in: ${fmtPrice(m.pricing.prompt)} | out: ${fmtPrice(m.pricing.completion)}`,
        }));

        // Navigation options
        if (pages > 1) {
            if (page < pages - 1) {
                options.push({ value: '__next__', label: `→ Next page (${page + 2}/${pages})`, hint: '' });
            }
            if (page > 0) {
                options.push({ value: '__prev__', label: `← Previous page`, hint: '' });
            }
        }
        options.push({ value: '__cancel__', label: 'Cancel', hint: '' });

        const choice = unwrap(await p.select({
            message: `Select a model (${start + 1}-${end} of ${filtered.length})`,
            options,
        }));

        if (choice === '__next__') { page++; continue; }
        if (choice === '__prev__') { page--; continue; }
        if (choice === '__cancel__') return;

        // Model selected — show details and config snippet
        const selected = filtered.find(m => m.id === choice)!;

        p.log.message('');
        p.log.success(`Selected: ${selected.name} (${selected.id})`);
        p.log.message(`  Context: ${fmtCtx(selected.context_length)} tokens`);
        p.log.message(`  Input:   ${fmtPrice(selected.pricing.prompt)}`);
        p.log.message(`  Output:  ${fmtPrice(selected.pricing.completion)}`);

        p.log.message('');
        p.log.message('To use this model, set an agent\'s provider to "custom:openrouter":');
        p.log.message('');
        p.log.message(`  tinyagi agent provider <agent_id> custom:openrouter --model ${selected.id}`);
        p.log.message('');
        p.log.message('Or in settings.json:');
        p.log.message(`  "provider": "custom:openrouter", "model": "${selected.id}"`);

        // Offer to set for an agent
        const agents = settings.agents || {};
        const agentIds = Object.keys(agents);
        if (agentIds.length > 0) {
            const setAgent = unwrap(await p.select({
                message: 'Apply to an agent?',
                options: [
                    { value: '__none__', label: 'No, just show the config' },
                    ...agentIds.map(id => ({
                        value: id,
                        label: `@${id} (currently ${agents[id].provider}/${agents[id].model})`,
                    })),
                ],
            }));

            if (setAgent !== '__none__') {
                agents[setAgent].provider = 'custom:openrouter';
                agents[setAgent].model = selected.id;

                // Ensure openrouter custom provider exists
                if (!settings.custom_providers) settings.custom_providers = {};
                if (!settings.custom_providers.openrouter) {
                    const key = unwrap(await p.text({
                        message: 'OpenRouter API key (get one at https://openrouter.ai/keys)',
                        placeholder: 'sk-or-...',
                    }));
                    settings.custom_providers.openrouter = {
                        name: 'openrouter',
                        harness: 'openai-compat' as any,
                        base_url: 'https://openrouter.ai/api/v1',
                        api_key: key,
                    };
                }

                writeSettings(settings);
                p.log.success(`@${setAgent} now uses ${selected.id} via OpenRouter`);
            }
        }

        break;
    }
}

// --- CLI dispatch ---

const command = process.argv[2];
const filterArg = process.argv[3];

switch (command) {
    case 'list':
    case 'ls':
    case undefined:
        modelsList();
        break;
    case 'browse':
        modelsBrowse(filterArg);
        break;
    default:
        p.log.error(`Unknown models command: ${command}`);
        p.log.message('Usage: tinyagi models {list|browse} [filter]');
        process.exit(1);
}

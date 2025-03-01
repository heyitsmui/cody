import { Configuration } from '@sourcegraph/cody-shared/src/configuration'
import { FeatureFlag, FeatureFlagProvider } from '@sourcegraph/cody-shared/src/experimentation/FeatureFlagProvider'

import { logError } from '../../log'
import { CodeCompletionsClient } from '../client'

import { createProviderConfig as createAnthropicProviderConfig } from './anthropic'
import { ProviderConfig } from './provider'
import { createProviderConfig as createUnstableCodeGenProviderConfig } from './unstable-codegen'
import { createProviderConfig as createUnstableFireworksProviderConfig } from './unstable-fireworks'
import { createProviderConfig as createUnstableOpenAIProviderConfig } from './unstable-openai'

export async function createProviderConfig(
    config: Configuration,
    client: CodeCompletionsClient,
    featureFlagProvider?: FeatureFlagProvider
): Promise<ProviderConfig | null> {
    const { provider, model } = await resolveDefaultProvider(config.autocompleteAdvancedProvider, featureFlagProvider)
    switch (provider) {
        case 'unstable-codegen': {
            if (config.autocompleteAdvancedServerEndpoint !== null) {
                return createUnstableCodeGenProviderConfig(config.autocompleteAdvancedServerEndpoint)
            }

            logError(
                'createProviderConfig',
                'Provider `unstable-codegen` can not be used without configuring `cody.autocomplete.advanced.serverEndpoint`.'
            )
            return null
        }
        case 'unstable-openai': {
            return createUnstableOpenAIProviderConfig({
                client,
                contextWindowTokens: 2048,
            })
        }
        case 'unstable-fireworks': {
            return createUnstableFireworksProviderConfig({
                client,
                model: config.autocompleteAdvancedModel ?? model ?? null,
            })
        }
        case 'anthropic': {
            return createAnthropicProviderConfig({
                client,
                contextWindowTokens: 2048,
                mode: config.autocompleteAdvancedModel === 'claude-instant-infill' ? 'infill' : 'default',
            })
        }
        default:
            logError(
                'createProviderConfig',
                `Unrecognized provider '${config.autocompleteAdvancedProvider}' configured.`
            )
            return null
    }
}

async function resolveDefaultProvider(
    configuredProvider: string | null,
    featureFlagProvider?: FeatureFlagProvider
): Promise<{ provider: string; model?: 'starcoder-7b' | 'starcoder-16b' | 'claude-instant-infill' }> {
    if (configuredProvider) {
        return { provider: configuredProvider }
    }

    const [starCoder7b, starCoder16b, claudeInstantInfill] = await Promise.all([
        featureFlagProvider?.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteStarCoder7B),
        featureFlagProvider?.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteStarCoder16B),
        featureFlagProvider?.evaluateFeatureFlag(FeatureFlag.CodyAutocompleteClaudeInstantInfill),
    ])

    if (starCoder7b === true || starCoder16b === true) {
        return { provider: 'unstable-fireworks', model: starCoder7b ? 'starcoder-7b' : 'starcoder-16b' }
    }

    if (claudeInstantInfill === true) {
        return { provider: 'anthropic', model: 'claude-instant-infill' }
    }

    return { provider: 'anthropic' }
}

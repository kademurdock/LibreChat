import React, { useMemo, useEffect } from 'react';
import keyBy from 'lodash/keyBy';
import { ControlCombobox } from '@librechat/client';
import { ChevronLeft, RotateCcw } from 'lucide-react';
import { useFormContext, useWatch, Controller } from 'react-hook-form';
import { componentMapping } from '~/components/SidePanel/Parameters/components';
import {
  alternateName,
  getSettingsKeys,
  getEndpointField,
  LocalStorageKeys,
  SettingDefinition,
  agentParamSettings,
  applyModelAwareDefaults,
} from 'librechat-data-provider';
import type * as t from 'librechat-data-provider';
import type { AgentForm, AgentModelPanelProps, StringOption } from '~/common';
import { useGetEndpointsQuery } from '~/data-provider';
import { useLiveAnnouncer } from '~/Providers';
import { useLocalize } from '~/hooks';
import { Panel } from '~/common';
import { cn } from '~/utils';

export default function ModelPanel({
  providers,
  setActivePanel,
  models: modelsData,
}: Pick<AgentModelPanelProps, 'models' | 'providers' | 'setActivePanel'>) {
  const localize = useLocalize();
  const { announcePolite } = useLiveAnnouncer();

  const { control, setValue } = useFormContext<AgentForm>();

  const model = useWatch({ control, name: 'model' });
  
// KADE July 16 2026: honest, plain-language notes for the curated model picker
// (librechat.yaml's OpenRouter list). Grounded in what is actually wired and
// measured on this fleet -- no marketing. Models not listed just show nothing.
const KADE_MODEL_NOTES: Record<string, string> = {
  'z-ai/glm-5.2': 'The house default. Smart, dependable, and great with tools -- if you are not sure, pick this.',
  'minimax/minimax-m3': 'Big flagship brain that can also see images you share. Good all-rounder, costs more than the default.',
  'z-ai/glm-4.7': 'The default’s cheaper sibling. Solid all-rounder for everyday characters.',
  'deepseek/deepseek-v4-flash': 'Very cheap and fast with a huge memory -- great for long, chatty conversations.',
  'deepseek/deepseek-v4-pro': 'The deep thinker. Slower, but strongest on hard problems and careful reasoning.',
  'google/gemini-3-flash-preview': 'Fast, and can see images, audio, and video you share.',
  'google/gemini-3.1-flash-lite': 'The fastest we have tested (replies in about a second) -- perfect for snappy characters.',
  'google/gemini-2.5-flash-lite': 'The cheapest quick chat. Fine for light banter, not for heavy lifting.',
  'xiaomi/mimo-v2.5': 'Cheap all-rounder that handles several media types.',
  'openai/gpt-4o-mini': 'The familiar one -- cheap, quick, and can see images.',
  'mistralai/mistral-nemo': 'A creative-roleplay classic. Cheap and playful; not built for tools or deep reasoning.',
  'nousresearch/hermes-4-70b': 'Uncensored workhorse for adult personas -- about 6x cheaper than the default. Cannot use tools (chat only).',
  'nousresearch/hermes-4-405b': 'Uncensored flagship, priced like the default. Cannot use tools (chat only).',
  'sao10k/l3.1-euryale-70b': 'A roleplay-community favorite with real personality. Tools work on this one.',
  'mistralai/mistral-small-2603': 'Light-touch and cheap, with tools and thinking. Good budget pick for capable characters.',
  'moonshotai/kimi-k2.5': 'Huge model that still feels fast in conversation. A star at lyrics and wordplay.',
  'x-ai/grok-4.20': 'Witty, with an enormous memory for very long chats. Strong at lyrics; pricier than most here.',
};

const providerOption = useWatch({ control, name: 'provider' });
  const modelParameters = useWatch({ control, name: 'model_parameters' });

  const provider = useMemo(() => {
    const value =
      typeof providerOption === 'string'
        ? providerOption
        : (providerOption as StringOption | undefined)?.value;
    return value ?? '';
  }, [providerOption]);
  const models = useMemo(
    () => (provider ? (modelsData[provider] ?? []) : []),
    [modelsData, provider],
  );

  useEffect(() => {
    const _model = model ?? '';
    if (provider && _model) {
      const modelExists = models.includes(_model);
      if (!modelExists) {
        const newModels = modelsData[provider] ?? [];
        setValue('model', newModels[0] ?? '');
      }
      localStorage.setItem(LocalStorageKeys.LAST_AGENT_MODEL, _model);
      localStorage.setItem(LocalStorageKeys.LAST_AGENT_PROVIDER, provider);
    }

    if (provider && !_model) {
      setValue('model', models[0] ?? '');
    }
  }, [provider, models, modelsData, setValue, model]);

  const { data: endpointsConfig = {} } = useGetEndpointsQuery();

  const bedrockRegions = useMemo(() => {
    return endpointsConfig?.[provider]?.availableRegions ?? [];
  }, [endpointsConfig, provider]);

  const endpointType = useMemo(
    () => getEndpointField(endpointsConfig, provider, 'type'),
    [provider, endpointsConfig],
  );

  const parameters = useMemo((): SettingDefinition[] => {
    const customParams = endpointsConfig[provider]?.customParams ?? {};
    const [combinedKey, endpointKey] = getSettingsKeys(endpointType ?? provider, model ?? '');
    const overriddenEndpointKey = customParams.defaultParamsEndpoint ?? endpointKey;
    const defaultParams =
      agentParamSettings[combinedKey] ?? agentParamSettings[overriddenEndpointKey] ?? [];
    const overriddenParams = endpointsConfig[provider]?.customParams?.paramDefinitions ?? [];
    const overriddenParamsMap = keyBy(overriddenParams, 'key');
    const modelAwareParams = applyModelAwareDefaults(
      defaultParams.filter((param) => param != null),
      overriddenEndpointKey,
      model ?? '',
    );
    return modelAwareParams.map(
      (param) => (overriddenParamsMap[param.key] as SettingDefinition) ?? param,
    );
  }, [endpointType, endpointsConfig, model, provider]);

  const setOption = (optionKey: keyof t.AgentModelParameters) => (value: t.AgentParameterValue) => {
    setValue(`model_parameters.${optionKey}`, value);
  };

  const handleResetParameters = () => {
    setValue('model_parameters', {} as t.AgentModelParameters);
    announcePolite({ message: localize('com_ui_model_parameters_reset'), isStatus: true });
  };

  return (
    <div className="mb-1 flex w-full flex-col gap-2 text-sm">
      <div className="model-panel relative flex flex-col items-center px-16 pt-2 text-center">
        <div className="absolute left-0 top-4">
          <button
            type="button"
            className="btn btn-neutral relative"
            onClick={() => {
              setActivePanel(Panel.builder);
            }}
            aria-label={localize('com_ui_back_to_builder')}
          >
            <div className="model-panel-content flex w-full items-center justify-center gap-2">
              <ChevronLeft />
            </div>
          </button>
        </div>

        <div className="mb-2 mt-2 text-xl font-medium">{localize('com_ui_model_parameters')}</div>
      </div>
      <div>
        {/* Endpoint aka Provider for Agents */}
        <div className="mb-4">
          <label
            id="provider-label"
            className="text-token-text-primary model-panel-label mb-2 block text-sm font-medium"
            htmlFor="provider"
          >
            {localize('com_ui_provider')} <span className="text-red-500">*</span>
          </label>
          <Controller
            name="provider"
            control={control}
            rules={{ required: true, minLength: 1 }}
            render={({ field, fieldState: { error } }) => {
              const value =
                typeof field.value === 'string'
                  ? field.value
                  : ((field.value as StringOption)?.value ?? '');
              const display =
                typeof field.value === 'string'
                  ? field.value
                  : ((field.value as StringOption)?.label ?? '');

              return (
                <>
                  <ControlCombobox
                    selectedValue={value}
                    displayValue={alternateName[display] ?? display}
                    selectPlaceholder={localize('com_ui_select_provider')}
                    searchPlaceholder={localize('com_ui_select_search_provider')}
                    setValue={field.onChange}
                    items={providers.map((provider) => ({
                      label: typeof provider === 'string' ? provider : provider.label,
                      value: typeof provider === 'string' ? provider : provider.value,
                    }))}
                    className={cn(error ? 'border-2 border-red-500' : '')}
                    ariaLabel={localize('com_ui_provider')}
                    isCollapsed={false}
                    showCarat={true}
                  />
                  {error && (
                    <span className="model-panel-error text-sm text-red-500 transition duration-300 ease-in-out">
                      {localize('com_ui_field_required')}
                    </span>
                  )}
                </>
              );
            }}
          />
        </div>
        {/* Model */}
        <div className="model-panel-section mb-4">
          <label
            id="model-label"
            className={cn(
              'text-token-text-primary model-panel-label mb-2 block text-sm font-medium',
              !provider && 'text-gray-500 dark:text-gray-400',
            )}
            htmlFor="model"
          >
            {localize('com_ui_model')} <span className="text-red-500">*</span>
          </label>
          <Controller
            name="model"
            control={control}
            rules={{ required: true, minLength: 1 }}
            render={({ field, fieldState: { error } }) => {
              return (
                <>
                  <ControlCombobox
                    selectedValue={field.value || ''}
                    selectPlaceholder={
                      provider
                        ? localize('com_ui_select_model')
                        : localize('com_ui_select_provider_first')
                    }
                    searchPlaceholder={localize('com_ui_select_model')}
                    setValue={field.onChange}
                    items={models.map((model) => ({
                      label: model,
                      value: model,
                    }))}
                    disabled={!provider}
                    className={cn('disabled:opacity-50', error ? 'border-2 border-red-500' : '')}
                    ariaLabel={localize('com_ui_model')}
                    isCollapsed={false}
                    showCarat={true}
                  />
                  {provider && error && (
                    <span className="text-sm text-red-500 transition duration-300 ease-in-out">
                      {localize('com_ui_field_required')}
                    </span>
                  )}
                  {/* KADE July 16 2026: plain-language note for the selected model.
                    * Ordinary in-flow text (not aria-live), so screen readers hit it
                    * right after the picker and sighted users see it update on pick. */}
                  {field.value && KADE_MODEL_NOTES[field.value] ? (
                    <p className="mt-2 text-sm text-text-secondary" id="kade-model-note">
                      {KADE_MODEL_NOTES[field.value]}
                    </p>
                  ) : null}
                </>
              );
            }}
          />
        </div>
      </div>
      {/* Model Parameters */}
      {parameters && (
        <div className="h-auto max-w-full">
          <div className="grid grid-cols-2 gap-4">
            {/* This is the parent element containing all settings */}
            {/* Below is an example of an applied dynamic setting, each be contained by a div with the column span specified */}
            {parameters.map((setting) => {
              const Component = componentMapping[setting.component];
              if (!Component) {
                return null;
              }
              const { key, default: defaultValue, ...rest } = setting;

              if (key === 'region' && bedrockRegions.length) {
                rest.options = bedrockRegions;
              }

              return (
                <Component
                  key={key}
                  settingKey={key}
                  defaultValue={defaultValue}
                  {...rest}
                  setOption={setOption as t.TSetOption}
                  conversation={modelParameters as Partial<t.TConversation>}
                />
              );
            })}
          </div>
        </div>
      )}
      {/* Reset Parameters Button */}
      <button
        type="button"
        onClick={handleResetParameters}
        className="btn btn-neutral my-1 flex w-full items-center justify-center gap-2 px-4 py-2 text-sm"
      >
        <RotateCcw className="h-4 w-4" aria-hidden="true" />
        {localize('com_ui_reset_var', { 0: localize('com_ui_model_parameters') })}
      </button>
    </div>
  );
}

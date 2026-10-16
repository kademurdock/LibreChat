import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@librechat/client';
import type * as t from 'librechat-data-provider';
import {
  useAgentBodyQuery,
  useAgentBodyCatalogQuery,
  useSaveAgentBodyMutation,
  useDeleteAgentBodyMutation,
  usePreviewAgentBodyMutation,
  useSurpriseAgentBodyMutation,
  useAgentBodyFromWordsMutation,
  useAgentBodyFromPortraitMutation,
} from '~/data-provider';
import { createPuppetRig } from '~/components/Chat/character/puppet/puppet-rig.mjs';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

/**
 * KADE Oct 16 2026 — the body editor in the agent builder. Screen reader and keyboard
 * first: every control is built from GET /api/kade/agent-body/catalog (radio groups,
 * a select for long lists, named colour swatches, range sliders with their two ends), and
 * after each change the words that changed in the body's description are read out. The
 * moving preview is decoration (aria-hidden) and holds still under reduced motion.
 */
type Recipe = t.TAgentBodyRecipe;
type Control = t.TAgentBodyControl;
type Scene = Record<string, unknown>;
type HttpError = {
  response?: { status?: number; data?: { error?: string; latest?: t.TAgentBody } };
};

const TRY_EXPRESSIONS = ['happy', 'surprised', 'thinking', 'laughing'];
const TRY_SECONDS = 1.6;
const PREVIEW_DEBOUNCE_MS = 300;
const LONG_LIST = 8; // more choices than this become a select

function getAt(recipe: Recipe, path: string): unknown {
  let node: unknown = recipe;
  for (const key of path.split('.'))
    node = node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined;
  return node;
}

function setAt(recipe: Recipe, path: string, value: unknown): Recipe {
  const keys = path.split('.');
  const out: Recipe = { ...recipe };
  let node: Record<string, unknown> = out;
  for (const key of keys.slice(0, -1)) {
    const child = node[key];
    const copy =
      child && typeof child === 'object' ? { ...(child as Record<string, unknown>) } : {};
    node[key] = copy;
    node = copy;
  }
  node[keys[keys.length - 1]] = value;
  return out;
}

/** The sentences of `after` that `before` did not have: what a change did to the words. */
export function changedSentences(before: string, after: string): string {
  const split = (s: string) => s.split(/(?<=[.!?])\s+/).filter(Boolean);
  const old = new Set(split(before));
  return split(after)
    .filter((s) => !old.has(s))
    .join(' ');
}

const errorOf = (err: unknown) => (err as HttpError)?.response;

function BodyPreview({
  agentId,
  scene,
  tryRequest,
}: {
  agentId: string;
  scene: Scene | null;
  tryRequest: number;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const rig = useRef<ReturnType<typeof createPuppetRig> | null>(null);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    if (!scene || !canvas.current) return;
    if (rig.current) {
      rig.current.setScene(scene);
      refresh.current();
      return;
    }
    rig.current = createPuppetRig(canvas.current, { id: agentId, scene });
    refresh.current();
  }, [agentId, scene]);
  useEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0,
      last = 0;
    const draw = () => {
      const active = !reduced.matches && !document.hidden;
      rig.current?.render({
        characterId: agentId,
        active,
        expression: 'neutral',
        mouth: 0,
        viseme: 0,
      });
      return active;
    };
    const loop = (now: number) => {
      frame = 0;
      if (now - last >= 1000 / 30) {
        last = now;
        if (!draw()) return;
      }
      frame = requestAnimationFrame(loop);
    };
    refresh.current = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (draw()) frame = requestAnimationFrame(loop);
    };
    refresh.current();
    reduced.addEventListener('change', refresh.current);
    document.addEventListener('visibilitychange', refresh.current);
    const stop = refresh.current;
    return () => {
      cancelAnimationFrame(frame);
      reduced.removeEventListener('change', stop);
      document.removeEventListener('visibilitychange', stop);
      refresh.current = () => {};
      rig.current?.dispose();
      rig.current = null;
    };
  }, [agentId]);
  // "Try an expression": a few seconds of each; under reduced motion each is a still.
  useEffect(() => {
    if (!tryRequest) return;
    const timers = TRY_EXPRESSIONS.map((name, i) =>
      setTimeout(
        () => {
          rig.current?.play(name, TRY_SECONDS);
          refresh.current();
        },
        i * TRY_SECONDS * 1000,
      ),
    );
    timers.push(
      setTimeout(() => refresh.current(), TRY_EXPRESSIONS.length * TRY_SECONDS * 1000 + 50),
    );
    return () => timers.forEach(clearTimeout);
  }, [tryRequest]);
  return (
    <div aria-hidden="true" className="mx-auto w-full max-w-[16rem]">
      <canvas
        ref={canvas}
        hidden
        aria-hidden="true"
        className="aspect-square w-full rounded-2xl bg-surface-secondary"
      />
      {!scene && (
        <div className="aspect-square w-full animate-pulse rounded-2xl bg-surface-secondary motion-reduce:animate-none" />
      )}
    </div>
  );
}

function ChoiceControl({
  control,
  value,
  onChange,
}: {
  control: Extract<Control, { kind: 'choice' }>;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = `agent-body-${control.path.replace(/\W/g, '-')}`;
  const note = (o: t.TAgentBodyOption) =>
    o.note && o.note.toLowerCase() !== o.name.toLowerCase() ? o.note : '';
  if (control.options.length > LONG_LIST)
    return (
      <div className="mb-3">
        <label htmlFor={id} className="mb-1 block text-sm font-medium text-text-primary">
          {control.name}
        </label>
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="w-full rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2"
        >
          {control.options.map((o) => (
            <option key={o.id} value={o.id}>
              {note(o) ? `${o.name}, ${note(o)}` : o.name}
            </option>
          ))}
        </select>
      </div>
    );
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-sm font-medium text-text-primary">{control.name}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {control.options.map((o) => (
          <label
            key={o.id}
            className="flex min-h-[44px] cursor-pointer items-start gap-2 rounded-lg px-2 py-2 text-sm text-text-primary hover:bg-surface-hover has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
          >
            <input
              type="radio"
              name={id}
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>
              {o.name}
              {note(o) && <span className="block text-xs text-text-secondary">{note(o)}</span>}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SwatchControl({
  name,
  groupId,
  options,
  value,
  onChange,
}: {
  name: string;
  groupId: string;
  options: t.TAgentBodyOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const chosen = options.find((o) => o.id === value);
  return (
    <fieldset className="mb-3">
      <legend className="mb-1 text-sm font-medium text-text-primary">{name}</legend>
      {/* The chosen name is shown for sighted people; each swatch already says its name. */}
      <p aria-hidden="true" className="mb-1 text-xs text-text-secondary">
        {chosen?.name}
      </p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((o) => (
          <label key={o.id} title={o.name} className="relative cursor-pointer">
            <input
              type="radio"
              name={groupId}
              value={o.id}
              checked={value === o.id}
              onChange={() => onChange(o.id)}
              className="peer sr-only"
            />
            <span
              aria-hidden="true"
              className="block h-9 w-9 rounded-full border border-border-medium peer-checked:ring-2 peer-checked:ring-text-primary peer-checked:ring-offset-2 peer-checked:ring-offset-surface-primary peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4"
              style={{
                background:
                  o.hex ?? 'repeating-linear-gradient(45deg, #d9d9d9 0 4px, #8a8a8a 4px 8px)',
              }}
            />
            <span className="sr-only">{o.name}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function SliderControl({
  control,
  value,
  onChange,
}: {
  control: Extract<Control, { kind: 'slider' }>;
  value: number;
  onChange: (value: number) => void;
}) {
  const localize = useLocalize();
  const id = `agent-body-${control.path.replace(/\W/g, '-')}`;
  const [low, high] = control.ends;
  return (
    <div className="mb-3">
      <label htmlFor={id} className="mb-1 block text-sm font-medium text-text-primary">
        {control.name}
      </label>
      <div className="flex items-center gap-2 text-xs text-text-secondary">
        <span aria-hidden="true" className="w-16 shrink-0 text-right">
          {low}
        </span>
        <input
          id={id}
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-valuetext={localize('com_ui_body_slider_value', {
            0: String(Math.round(value * 100)),
            1: low,
            2: high,
          })}
          className="min-h-[44px] flex-1 focus-visible:outline focus-visible:outline-2"
        />
        <span aria-hidden="true" className="w-16 shrink-0">
          {high}
        </span>
      </div>
    </div>
  );
}

export default function AgentBodyEditor({
  agentId,
  hasPortrait,
}: {
  agentId: string;
  hasPortrait: boolean;
}) {
  const localize = useLocalize();
  const catalog = useAgentBodyCatalogQuery();
  const saved = useAgentBodyQuery(agentId);
  const save = useSaveAgentBodyMutation();
  const remove = useDeleteAgentBodyMutation();
  const { mutateAsync: previewBody } = usePreviewAgentBodyMutation();
  const surprise = useSurpriseAgentBodyMutation();
  const fromWords = useAgentBodyFromWordsMutation();
  const fromPortrait = useAgentBodyFromPortraitMutation();

  const [draft, setDraft] = useState<Recipe | null>(null);
  const [baseRev, setBaseRev] = useState(0);
  const [source, setSource] = useState<t.TAgentBodySource>('editor');
  const [scene, setScene] = useState<Scene | null>(null);
  const [description, setDescription] = useState('');
  const [dirty, setDirty] = useState(false);
  const [spoken, setSpoken] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState<'' | 'surprise' | 'words' | 'portrait' | 'save' | 'remove'>('');
  const [wordsOpen, setWordsOpen] = useState(false);
  const [words, setWords] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [conflict, setConflict] = useState<t.TAgentBody | null>(null);
  const [tryRequest, setTryRequest] = useState(0);
  const descriptionRef = useRef('');
  descriptionRef.current = description;
  const previewSeq = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const conflictButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const removeTrigger = useRef<HTMLButtonElement>(null);
  const saveButton = useRef<HTMLButtonElement>(null);
  // A panel that closes under the focused button would drop focus to the page, so the
  // next sensible control takes it once the panel is gone.
  const focusSoon = (target: { current: HTMLElement | null }) =>
    setTimeout(() => target.current?.focus(), 0);

  const say = useCallback((text: string) => {
    // Clear first so the same words twice are still read.
    setSpoken('');
    if (text) setTimeout(() => setSpoken(text), 60);
  }, []);

  /** Take a compiled body (saved, previewed or designed) into the editor. */
  const adopt = useCallback(
    (body: t.TAgentBody, announce: 'all' | 'changes' | 'none') => {
      if (body.recipe) setDraft(body.recipe);
      if (body.scene) setScene(body.scene);
      const next = body.description ?? '';
      const before = descriptionRef.current;
      setDescription(next);
      if (announce === 'all') say(next);
      else if (announce === 'changes') say(changedSentences(before, next));
    },
    [say],
  );

  const requestPreview = useCallback(
    (recipe: Recipe, announce = true) => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
      const mine = ++previewSeq.current;
      previewTimer.current = setTimeout(() => {
        previewBody(recipe)
          .then((body) => {
            if (mine !== previewSeq.current) return;
            // Keep the person's own draft (the server's copy is the same, normalized).
            setScene(body.scene ?? null);
            const before = descriptionRef.current;
            setDescription(body.description ?? '');
            if (announce) say(changedSentences(before, body.description ?? ''));
          })
          .catch(() => {
            if (mine === previewSeq.current) setStatus(localize('com_ui_body_error'));
          });
      }, PREVIEW_DEBOUNCE_MS);
    },
    [previewBody, say, localize],
  );
  useEffect(
    () => () => {
      if (previewTimer.current) clearTimeout(previewTimer.current);
    },
    [],
  );

  // Start from the saved body, or from the kit's defaults for a character without one.
  useEffect(() => {
    if (draft || !catalog.data || !saved.data) return;
    setBaseRev(saved.data.rev || 0);
    if (saved.data.recipe) adopt(saved.data, 'none');
    else {
      setDraft(catalog.data.defaults);
      requestPreview(catalog.data.defaults, false);
    }
  }, [draft, catalog.data, saved.data, adopt, requestPreview]);

  useEffect(() => {
    if (conflict) conflictButton.current?.focus();
  }, [conflict]);

  const change = (next: Recipe) => {
    setDraft(next);
    setDirty(true);
    setSource('editor');
    setStatus('');
    requestPreview(next);
  };

  const design = async (
    kind: 'surprise' | 'words' | 'portrait',
    run: () => Promise<t.TAgentBody>,
    madeBy: t.TAgentBodySource,
  ) => {
    if (busy) return;
    setBusy(kind);
    setStatus(localize('com_ui_body_working'));
    previewSeq.current++;
    try {
      const body = await run();
      adopt(body, 'all');
      setDirty(true);
      setSource(madeBy);
      setStatus(
        typeof body.costUSD === 'number'
          ? localize('com_ui_body_cost', { 0: `$${body.costUSD.toFixed(4)}` })
          : '',
      );
    } catch (err) {
      setStatus(errorOf(err)?.data?.error || localize('com_ui_body_error'));
    } finally {
      setBusy('');
    }
  };

  const doSave = async (rev: number) => {
    if (!draft || busy) return;
    setBusy('save');
    if (conflict) focusSoon(saveButton);
    setConflict(null);
    try {
      const body = await save.mutateAsync({ agentId, recipe: draft, baseRev: rev, source });
      setBaseRev(body.rev);
      setDirty(false);
      setStatus(localize('com_ui_body_saved'));
    } catch (err) {
      const response = errorOf(err);
      if (response?.status === 409 && response.data?.latest) setConflict(response.data.latest);
      else setStatus(response?.data?.error || localize('com_ui_body_error'));
    } finally {
      setBusy('');
    }
  };

  const loadTheirs = () => {
    if (!conflict || !catalog.data) return;
    setBaseRev(conflict.rev || 0);
    if (conflict.recipe) adopt(conflict, 'all');
    else {
      setDraft(catalog.data.defaults);
      requestPreview(catalog.data.defaults);
    }
    setDirty(false);
    setConflict(null);
    focusSoon(saveButton);
  };

  const doRemove = async () => {
    if (busy) return;
    setBusy('remove');
    try {
      await remove.mutateAsync(agentId);
      setBaseRev(0);
      setDirty(false);
      setConfirmRemove(false);
      focusSoon(saveButton);
      setStatus(localize('com_ui_body_removed'));
      if (catalog.data) {
        setDraft(catalog.data.defaults);
        requestPreview(catalog.data.defaults);
      }
    } catch (err) {
      setStatus(errorOf(err)?.data?.error || localize('com_ui_body_error'));
    } finally {
      setBusy('');
    }
  };

  if (catalog.isError || saved.isError)
    return <p role="alert">{localize('com_ui_body_unavailable')}</p>;
  if (!catalog.data || !saved.data || !draft)
    return <p role="status">{localize('com_ui_body_loading')}</p>;

  const hasSaved = baseRev > 0;
  const sections = catalog.data.catalog.sections;
  const control = (c: Control) => {
    if (c.kind === 'slider') {
      const v = Number(getAt(draft, c.path));
      return (
        <SliderControl
          key={c.path}
          control={c}
          value={Number.isFinite(v) ? v : 0.5}
          onChange={(v2) => change(setAt(draft, c.path, v2))}
        />
      );
    }
    if (c.kind === 'accessory') {
      const ids = new Set(c.options.map((o) => o.id).filter(Boolean));
      const worn = draft.accessories ?? [];
      const value = worn.find((id) => ids.has(id)) ?? '';
      const options = c.options.map((o) => (o.id ? o : { ...o, name: localize('com_ui_none') }));
      return (
        <ChoiceControl
          key={`accessory-${c.slot}`}
          control={{ path: `accessories.${c.slot}`, kind: 'choice', name: c.name, options }}
          value={value}
          onChange={(id) =>
            change({
              ...draft,
              accessories: [...worn.filter((w) => !ids.has(w)), ...(id ? [id] : [])],
            })
          }
        />
      );
    }
    if (c.options.length < 2) return null;
    const value = String(getAt(draft, c.path) ?? '');
    if (c.kind === 'color')
      return (
        <SwatchControl
          key={c.path}
          name={c.name}
          groupId={`agent-body-${c.path.replace(/\W/g, '-')}`}
          options={c.options}
          value={value}
          onChange={(v) => change(setAt(draft, c.path, v))}
        />
      );
    return (
      <ChoiceControl
        key={c.path}
        control={c}
        value={value}
        onChange={(v) => change(setAt(draft, c.path, v))}
      />
    );
  };
  const actionClass = 'min-h-[44px]';
  // Busy buttons say so (aria-disabled) but keep focus; a disabled button would drop it.
  const held = (blocked: boolean) =>
    blocked
      ? {
          'aria-disabled': true as const,
          className: cn(actionClass, 'cursor-not-allowed opacity-50'),
        }
      : { className: actionClass };

  return (
    <div className="grid gap-4">
      <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {spoken}
      </p>
      <BodyPreview agentId={agentId} scene={scene} tryRequest={tryRequest} />
      <section aria-labelledby="agent-body-words-now">
        <h3 id="agent-body-words-now" className="text-sm font-medium text-text-primary">
          {localize('com_ui_body_description')}
        </h3>
        <p className="text-sm leading-relaxed text-text-primary">{description}</p>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          {...held(!!busy)}
          onClick={() =>
            design(
              'surprise',
              () => surprise.mutateAsync({ seed: `${agentId}-${Date.now()}` }),
              'surprise',
            )
          }
        >
          {localize('com_ui_body_surprise')}
        </Button>
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          aria-expanded={wordsOpen}
          aria-controls="agent-body-words-panel"
          onClick={() => setWordsOpen((v) => !v)}
        >
          {localize('com_ui_body_words')}
        </Button>
        {hasPortrait && (
          <Button
            type="button"
            variant="outline"
            {...held(!!busy)}
            onClick={() => design('portrait', () => fromPortrait.mutateAsync(agentId), 'picture')}
          >
            {localize('com_ui_body_portrait')}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          className={actionClass}
          disabled={!scene}
          onClick={() => {
            setTryRequest((n) => n + 1);
            say(localize('com_ui_body_trying'));
          }}
        >
          {localize('com_ui_body_try')}
        </Button>
      </div>
      {wordsOpen && (
        <div id="agent-body-words-panel" className="grid gap-2">
          <label htmlFor="agent-body-words" className="text-sm font-medium text-text-primary">
            {localize('com_ui_body_words_label')}
          </label>
          <p id="agent-body-words-hint" className="text-xs text-text-secondary">
            {localize('com_ui_body_words_hint')}
          </p>
          <textarea
            id="agent-body-words"
            aria-describedby="agent-body-words-hint"
            value={words}
            maxLength={1500}
            rows={3}
            onChange={(e) => setWords(e.target.value)}
            className="w-full rounded-lg border border-border-light bg-surface-secondary px-3 py-2 text-sm text-text-primary focus-visible:outline focus-visible:outline-2"
          />
          <div>
            <Button
              type="button"
              {...held(!!busy || words.trim().length < 3)}
              onClick={() =>
                words.trim().length >= 3 &&
                design(
                  'words',
                  () => fromWords.mutateAsync({ words: words.trim(), base: draft }),
                  'words',
                )
              }
            >
              {localize('com_ui_body_words_submit')}
            </Button>
          </div>
        </div>
      )}
      {status && (
        <p role="status" className="text-sm text-text-primary">
          {status}
        </p>
      )}
      {conflict && (
        <div className="grid gap-2 rounded-xl border border-border-medium p-3">
          <div role="alert" className="grid gap-2">
            <p className="text-sm text-text-primary">{localize('com_ui_body_conflict')}</p>
            <p className="text-sm text-text-secondary">
              {conflict.description
                ? localize('com_ui_body_conflict_theirs', { 0: conflict.description })
                : localize('com_ui_body_conflict_removed')}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={conflictButton}
              type="button"
              variant="outline"
              className={actionClass}
              onClick={loadTheirs}
            >
              {localize('com_ui_body_load_theirs')}
            </Button>
            <Button
              type="button"
              variant="outline"
              {...held(!!busy)}
              onClick={() => doSave(conflict.rev || 0)}
            >
              {localize('com_ui_body_overwrite')}
            </Button>
          </div>
        </div>
      )}
      {sections.map((section) => (
        <details key={section.id} className="rounded-xl border border-border-light px-3">
          <summary className="min-h-[44px] cursor-pointer py-3 text-sm font-medium text-text-primary focus-visible:outline focus-visible:outline-2">
            {section.name}
          </summary>
          <div className="pb-2">{section.controls.map(control)}</div>
        </details>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          ref={saveButton}
          type="button"
          {...held(!!busy || (!dirty && hasSaved))}
          onClick={() => (dirty || !hasSaved) && doSave(baseRev)}
        >
          {localize('com_ui_body_save')}
        </Button>
        {dirty && (
          <span className="text-xs text-text-secondary">{localize('com_ui_body_unsaved')}</span>
        )}
        {hasSaved && (
          <Button
            ref={removeTrigger}
            type="button"
            variant="outline"
            aria-expanded={confirmRemove}
            className={cn(actionClass, 'ml-auto')}
            onClick={() => {
              setConfirmRemove(true);
              focusSoon(removeButton);
            }}
          >
            {localize('com_ui_body_remove')}
          </Button>
        )}
      </div>
      {confirmRemove && (
        <div className="grid gap-2 rounded-xl border border-border-medium p-3">
          <p className="text-sm text-text-primary">{localize('com_ui_body_remove_question')}</p>
          <div className="flex flex-wrap gap-2">
            <Button
              ref={removeButton}
              type="button"
              variant="destructive"
              {...held(!!busy)}
              onClick={doRemove}
            >
              {localize('com_ui_body_remove_confirm')}
            </Button>
            <Button
              type="button"
              variant="outline"
              className={actionClass}
              onClick={() => {
                setConfirmRemove(false);
                focusSoon(removeTrigger);
              }}
            >
              {localize('com_ui_cancel')}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

'use client';

// The being's own settings (theme CSS, voice, pronunciation dict, context
// budget, wake schedule, Live voice), shown inside the conversation-settings
// dialog's 「存在」 tab since 2026-11-15.
//
// They used to live in a separate dialog opened from the sidebar's ⋮ menu
// ("存在設定"). つよ's remaster: a being only lives in its newest conversation,
// so two settings dialogs were one dialog split in an arbitrary place — and
// the sidebar one was the hard-to-find half. The fields and the save path are
// unchanged; only where they are drawn moved. The wake schedule is drawn from
// the 「挙動」 tab (it is a reason to wake up), but it is the same draft and is
// saved by the same `save()`.
//
// Saved explicitly (on 「完了」 in the dialog), unlike the conversation-level
// controls around it which apply as you edit: these keys go to settings.json
// as a PATCH (lib/beingSettingsMerge.ts), and the pronunciation dict to its own
// file, so a malformed dict can still block the save and say why.

import React, { useCallback, useState } from 'react';
import { Upload, Settings2, Mic } from 'lucide-react';
import VoiceSelector from './VoiceSelector';
import {
  DEFAULT_MAX_CONVERSATION_LOG,
  LOG_CAP_UNIT,
  LOG_CAP_MIN_UNITS,
  LOG_CAP_MAX_UNITS,
  clampLogCapUnits,
} from '@/lib/handoverRestore';
import { useT, Tx } from '@/lib/i18n';
import { parseWakeSettings, type WakeSettings } from '@/lib/wakeSchedule';

const LIVE_FEMININE = ['Aoede','Kore','Leda','Zephyr','Achernar','Autonoe','Callirhoe','Despina','Erinome','Gacrux','Laomedeia','Pulcherrima','Sulafat','Vindemiatrix'];
const LIVE_MASCULINE = ['Puck','Charon','Fenrir','Orus','Achird','Algenib','Algieba','Alnilam','Enceladus','Iapetus','Rasalgethi','Sadachbia','Sadaltager','Schedar','Umbriel','Zubenelgenubi'];

export type BeingSettingsDraft = ReturnType<typeof useBeingSettingsDraft>;

export function useBeingSettingsDraft(folderName: string) {
  const t = useT();
  const [customCss, setCustomCss] = useState('');
  const [ttsDict, setTtsDict] = useState('');
  const [ttsDictError, setTtsDictError] = useState<string | null>(null);
  const [voice, setVoice] = useState({ engine: 0, char_idx: 0, style_idx: 0 });
  const [voicePitch, setVoicePitch] = useState(0.0);
  const [maxConversationLog, setMaxConversationLog] = useState<number>(DEFAULT_MAX_CONVERSATION_LOG);
  const [autoTrim, setAutoTrim] = useState(true);
  const [wake, setWake] = useState<WakeSettings>(() => parseWakeSettings(undefined));
  const [liveSessionVoice, setLiveSessionVoice] = useState('Aoede');
  const [liveVoiceMode, setLiveVoiceMode] = useState<'preset' | 'custom'>('preset');
  const [liveCustomVoice, setLiveCustomVoice] = useState('');
  // Set by load(); nothing is saved for a being whose settings were never
  // read into this draft (a save would otherwise write the defaults above).
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Wrap a setter so editing marks the draft dirty.
  const edit = <A,>(fn: (a: A) => void) => (a: A) => { fn(a); setDirty(true); };

  const load = useCallback((settings: any) => {
    const s = settings || {};
    setCustomCss(s.customCss || '');
    setTtsDict(''); setTtsDictError(null);
    fetch(`/api/tts-dict?folder=${encodeURIComponent(folderName)}`)
      .then(r => r.json()).then(d => setTtsDict(d.content || '')).catch(() => {});
    setVoice(s.aiVoice || { engine: 0, char_idx: 0, style_idx: 0 });
    setVoicePitch(s.voicePitch ?? 0.0);
    // Deliberately no fallback to the retired `maxRecommendedContext`: it
    // capped a different quantity, so inheriting it would hand every being a
    // cap it was never given.
    setMaxConversationLog(s.maxConversationLog ?? DEFAULT_MAX_CONVERSATION_LOG);
    setAutoTrim(s.autoTrimCopiedMessages !== false);
    setWake(parseWakeSettings(s.wake));
    const lv = s.liveSessionVoice || 'Aoede';
    if ([...LIVE_FEMININE, ...LIVE_MASCULINE].includes(lv)) {
      setLiveVoiceMode('preset'); setLiveSessionVoice(lv); setLiveCustomVoice('');
    } else {
      setLiveVoiceMode('custom'); setLiveCustomVoice(lv); setLiveSessionVoice('Aoede');
    }
    setLoadedFor(folderName);
    setDirty(false);
  }, [folderName]);

  /** Returns false (and sets an error) when the dict is malformed — the
   *  dialog then stays open on the 存在 tab. True when saved or nothing to do. */
  const save = useCallback(async (): Promise<boolean> => {
    if (!dirty || loadedFor !== folderName) return true;
    const dictText = ttsDict.trim();
    if (dictText) {
      try {
        const o = JSON.parse(dictText);
        if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error();
      } catch {
        setTtsDictError(t('folder.dict.error'));
        return false;
      }
    }
    setTtsDictError(null);
    await fetch('/api/tts-dict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: folderName, content: ttsDict }),
    }).catch(() => {});
    // Only the keys this draft owns; the server lays them over what is on
    // disk, so a key this tab never fetched cannot be lost here.
    await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: folderName,
        remove: ['maxRecommendedContext'],
        patch: {
          customCss,
          aiVoice: voice,
          voicePitch,
          maxConversationLog,
          autoTrimCopiedMessages: autoTrim,
          wake,
          liveSessionVoice: liveVoiceMode === 'custom' ? liveCustomVoice.trim() : liveSessionVoice,
        },
      }),
    });
    setDirty(false);
    return true;
  }, [dirty, loadedFor, folderName, ttsDict, customCss, voice, voicePitch, maxConversationLog, autoTrim, wake, liveVoiceMode, liveCustomVoice, liveSessionVoice, t]);

  return {
    folderName, load, save, dirty,
    customCss, setCustomCss: edit(setCustomCss),
    ttsDict, setTtsDict: edit((v: string) => { setTtsDict(v); setTtsDictError(null); }),
    ttsDictError,
    voice, setVoice: edit(setVoice),
    voicePitch, setVoicePitch: edit(setVoicePitch),
    maxConversationLog, setMaxConversationLog: edit(setMaxConversationLog),
    autoTrim, setAutoTrim: edit(setAutoTrim),
    wake, setWake: edit(setWake),
    liveSessionVoice, setLiveSessionVoice: edit(setLiveSessionVoice),
    liveVoiceMode, setLiveVoiceMode: edit(setLiveVoiceMode),
    liveCustomVoice, setLiveCustomVoice: edit(setLiveCustomVoice),
  };
}

export default function BeingSettingsFields({ draft: d }: { draft: BeingSettingsDraft }) {
  const t = useT();
  return (
    <>
      <p className="text-xs text-muted-foreground">{t('folder.savedOnDone')}</p>
      <div>
        <div className="flex items-center justify-between mb-2">
          <label className="text-sm font-semibold text-foreground">{t('folder.css.label')}</label>
          <label className="cursor-pointer text-xs flex items-center gap-1 text-indigo-500 hover:text-indigo-400">
            <Upload size={14} /> {t('folder.css.load')}
            <input
              type="file"
              accept=".css"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = (event) => d.setCustomCss(event.target?.result as string);
                reader.readAsText(file);
                e.target.value = '';
              }}
            />
          </label>
        </div>
        <textarea
          value={d.customCss}
          onChange={(e) => d.setCustomCss(e.target.value)}
          placeholder={t('folder.css.placeholder')}
          className="w-full h-48 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
        />
        <p className="text-[10px] text-muted-foreground mt-1">
          <Tx k="folder.css.help" />
        </p>
      </div>

      <div className="pt-4 border-t border-border">
        <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4">
          <Mic size={16} /> {t('folder.voice.heading')}
        </h4>
        <VoiceSelector value={d.voice} onChange={d.setVoice} />
        <div className="mt-3">
          <label className="text-xs font-medium text-muted-foreground block mb-1">
            {t('folder.voice.pitch')} ({d.voicePitch >= 0 ? '+' : ''}{d.voicePitch.toFixed(2)})
          </label>
          <input
            type="range" min="-0.5" max="0.5" step="0.01"
            value={d.voicePitch}
            onChange={(e) => d.setVoicePitch(parseFloat(e.target.value))}
            className="w-full"
          />
          <div className="flex justify-between text-[10px] text-muted-foreground mt-0.5">
            <span>{t('folder.voice.lower')}</span>
            <span>{t('folder.voice.default')}</span>
            <span>{t('folder.voice.higher')}</span>
          </div>
        </div>
        <div className="mt-4">
          <label className="text-xs font-medium text-muted-foreground block mb-1">{t('folder.dict.label')}</label>
          <textarea
            value={d.ttsDict}
            onChange={(e) => d.setTtsDict(e.target.value)}
            placeholder={t('folder.dict.placeholder')}
            className="w-full h-32 p-3 bg-background border border-border rounded-lg font-mono text-xs focus:ring-2 focus:ring-indigo-500/50 resize-none custom-scrollbar"
          />
          {d.ttsDictError
            ? <p className="text-[10px] text-red-500 mt-1">{d.ttsDictError}</p>
            : <p className="text-[10px] text-muted-foreground mt-1"><Tx k="folder.dict.help" /></p>}
        </div>
      </div>

      <div className="pt-4 border-t border-border">
        <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4">
          <Settings2 size={16} /> {t('folder.context.heading')}
        </h4>
        <div className="space-y-4">
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="text-xs font-medium text-muted-foreground">{t('folder.logcap.label')}</label>
              <span className="text-xs font-mono text-indigo-500">
                {(d.maxConversationLog || 0).toLocaleString()} {t('folder.context.tokens')}
              </span>
            </div>
            {/* Edited in units of 10k tokens. `Math.round` is DISPLAY only — a
                stored value that isn't a multiple of 10k keeps its exact bytes
                until this field is actually edited. */}
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={LOG_CAP_MIN_UNITS}
                max={LOG_CAP_MAX_UNITS}
                step={1}
                value={Math.round((d.maxConversationLog ?? DEFAULT_MAX_CONVERSATION_LOG) / LOG_CAP_UNIT)}
                onChange={(e) => d.setMaxConversationLog(clampLogCapUnits(parseInt(e.target.value, 10)) * LOG_CAP_UNIT)}
                className="w-24 p-2 bg-background border border-border rounded-lg text-sm font-mono"
              />
              <span className="text-[10px] text-muted-foreground">{t('folder.logcap.units')}</span>
            </div>
            <div className="text-[10px] text-muted-foreground mt-1"><Tx k="folder.logcap.help" /></div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer text-sm">
            <input
              type="checkbox"
              checked={d.autoTrim}
              onChange={(e) => d.setAutoTrim(e.target.checked)}
              className="accent-indigo-500"
            />
            <span>{t('folder.context.autoTrim')}</span>
          </label>
          <div className="text-[10px] text-muted-foreground -mt-2 leading-relaxed">
            <Tx k="folder.context.autoTrim.help" />
          </div>
        </div>
      </div>

      <div className="pt-4 border-t border-border">
        <h4 className="text-sm font-semibold flex items-center gap-2 text-indigo-500 mb-4">
          <Mic size={16} /> {t('folder.live.heading')}
        </h4>
        <select
          value={d.liveVoiceMode === 'custom' ? '__custom__' : d.liveSessionVoice}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '__custom__') d.setLiveVoiceMode('custom');
            else { d.setLiveVoiceMode('preset'); d.setLiveSessionVoice(v); }
          }}
          className="w-full p-2 bg-background border border-border rounded-lg text-sm"
        >
          <optgroup label={t('folder.live.feminine')}>
            {LIVE_FEMININE.map(v => <option key={v} value={v}>{v}</option>)}
          </optgroup>
          <optgroup label={t('folder.live.masculine')}>
            {LIVE_MASCULINE.map(v => <option key={v} value={v}>{v}</option>)}
          </optgroup>
          <option value="__custom__">{t('folder.live.custom')}</option>
        </select>
        {d.liveVoiceMode === 'custom' && (
          <input
            type="text"
            value={d.liveCustomVoice}
            onChange={(e) => d.setLiveCustomVoice(e.target.value)}
            placeholder={t('folder.live.customPlaceholder')}
            className="mt-2 w-full p-2 bg-background border border-border rounded-lg text-sm"
          />
        )}
        <div className="text-[10px] text-muted-foreground mt-2 leading-relaxed">{t('folder.live.help')}</div>
      </div>
    </>
  );
}

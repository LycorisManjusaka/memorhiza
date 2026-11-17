/**
 * Turning a message into the phrases a TTS engine is handed, one at a time.
 *
 * ONE definition for the tab (MessageBubble's Read Aloud) and the server
 * (lib/serverSpeech.ts). The phrase text is also what the highlight searches
 * for in the bubble, so two splitters that disagreed by one character would
 * make the server speak a phrase no tab can find.
 */
import { stripAllTimestamps, isOnlyTimestamps } from '@/lib/timestampStrip';

export interface TtsSegment {
  text: string;
  engine: number | string;
  char_idx: number;
  style_idx: number;
  char_name?: string;
  style_name?: string;
  speed: number;
  pitch: number;
}

/** A saved voice (settings.aiVoice / userVoice) plus a pitch -> one segment's voice fields. */
export function segmentFor(text: string, voice: Record<string, unknown> | null | undefined, pitch: number): TtsSegment {
  const v = voice || {};
  return {
    text,
    engine: (v.engine as number | string) || 0,
    char_idx: Number(v.char_idx) || 0,
    style_idx: Number(v.style_idx) || 0,
    char_name: typeof v.char_name === 'string' ? v.char_name : undefined,
    style_name: typeof v.style_name === 'string' ? v.style_name : undefined,
    speed: Number(v.speed) || 1.0,
    pitch,
  };
}

/** Split on Japanese sentence enders and newlines; the ender stays with its sentence. */
export function splitTtsSentences<T extends { text: string }>(segments: T[]): T[] {
  const out: T[] = [];
  for (const seg of segments) {
    const parts = String(seg.text || '').split(/([。！？\n」]+)/);
    for (let i = 0; i < parts.length; i += 2) {
      const chunk = parts[i] + (parts[i + 1] || '');
      if (chunk.trim()) out.push({ ...seg, text: chunk.trim() });
    }
  }
  return out;
}

/**
 * A being's finished reply -> phrases in that being's own voice. Timestamp tags
 * are stripped everywhere (the being echoes them back; hearing a date read
 * aloud breaks the session). Empty when there is nothing to say.
 */
export function assistantSpeechSentences(
  content: string,
  voice: Record<string, unknown> | null | undefined,
  pitch: number,
): TtsSegment[] {
  const src = String(content || '');
  if (isOnlyTimestamps(src)) return [];
  const cleaned = stripAllTimestamps(src);
  if (!cleaned.trim()) return [];
  return splitTtsSentences([segmentFor(cleaned, voice, pitch)]);
}

// « OK Tent » speaks: Rust (src-tauri/src/voice/mod.rs `speak`) sends the
// answer as `voice-say`; the island's page says it out loud and tells Rust
// when it is done (voice_done), which then listens again. ElevenLabs' MP3 when
// it came with one, else the system's voice in the answer's language, else
// (Linux, a webview without voices) speech-dispatcher or espeak-ng.
// Moved here from the Flow pill's page, unchanged.

import { onEvent } from "../core/bridge";
import { FlowBridge } from "../core/flow";

interface Say {
  id: number;
  text: string;
  lang: string | null;
  /** ElevenLabs' MP3, base64. */
  audio: string | null;
  gender: "female" | "male";
}

/** The system's voice in the answer's language, a woman's or a man's when the system says. */
function systemVoice(lang: string | null, gender: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis?.getVoices() ?? [];
  const want = (lang ?? navigator.language).toLowerCase();
  const short = want.split("-")[0];
  const inLang = voices.filter((v) => v.lang.toLowerCase() === want).concat(voices.filter((v) => v.lang.toLowerCase().split(/[-_]/)[0] === short && v.lang.toLowerCase() !== want));
  const female = /(female|woman|zira|hortense|julie|denise|aria|jenny|samantha|amelie|eloise)/i;
  const male = /(male|man\b|david|paul|guy|henri|claude|mark|thomas)/i;
  const pick = inLang.find((v) => (gender === "male" ? male.test(v.name) && !female.test(v.name) : female.test(v.name)));
  return pick ?? inLang[0] ?? null;
}

async function sayWithSystem(text: string, lang: string | null, gender: string): Promise<void> {
  const synth = window.speechSynthesis;
  if (synth && synth.getVoices().length === 0) {
    await new Promise<void>((r) => {
      synth.addEventListener("voiceschanged", () => r(), { once: true });
      setTimeout(r, 600);
    });
  }
  if (synth && synth.getVoices().length > 0) {
    await new Promise<void>((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      const voice = systemVoice(lang, gender);
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? lang ?? navigator.language;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      synth.cancel();
      synth.speak(u);
    });
    return;
  }
  await FlowBridge.sayNative(text, lang);
}

async function sayMp3(base64: string): Promise<boolean> {
  try {
    const audio = new Audio(`data:audio/mpeg;base64,${base64}`);
    await audio.play();
    await new Promise<void>((resolve) => {
      audio.onended = () => resolve();
      audio.onerror = () => resolve();
    });
    return true;
  } catch {
    return false;
  }
}

async function say(s: Say) {
  try {
    if (!(s.audio && (await sayMp3(s.audio)))) await sayWithSystem(s.text, s.lang, s.gender);
  } finally {
    void FlowBridge.voiceDone(s.id);
  }
}

export function registerVoiceSay() {
  void onEvent<Say>("voice-say", (s) => void say(s));
}

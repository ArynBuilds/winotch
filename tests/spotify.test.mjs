// The Spotify pill (Linux) and when the mark dances: the page's rules in
// src/core/spotify.ts, the report handling in
// src/island/spotify.ts and the views in src/views/spotify.ts. The MPRIS side —
// metadata, position, the bus itself — is tested in src-tauri/src/spotify.rs.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { emit, sent } from "./tauri.mjs";
import { installFakeDom } from "./fakedom.mjs";
import {
  IDLE_SPOTIFY, SPOTIFY_ID, Spotify, currentArtwork, formatTime, isAd, islandDances,
  musicPlaying, spotifyPosition, volumeLevel, withPlaying,
} from "../src/core/spotify.ts";
import { registerSpotifyHandlers } from "../src/island/spotify.ts";
import { buildSpotifyCard, buildSpotifyPill } from "../src/views/spotify.ts";
import { DEFAULT_SETTINGS, State } from "../src/core/state.ts";
import { useRegistry } from "./registry.mjs";
import { lookup, setLanguage } from "../src/i18n/i18n.ts";

installFakeDom();

const track = (over = {}) => ({
  id: "spotify:track:abc", title: "Get Lucky", artist: "Daft Punk", album: "Random Access Memories",
  duration: 180, artUrl: "https://i.scdn.co/image/abc", ...over,
});

const playing = (over = {}) => ({
  ...IDLE_SPOTIFY, running: true, installed: true, track: track(), playing: true,
  position: 10, positionAt: 1_000, volume: 70, ...over,
});

// ── Position ──────────────────────────────────────────────────────────────────

test("the position runs on from its timestamp while playing, and stops at the end", () => {
  const s = playing();
  assert.equal(spotifyPosition(s, 1_000), 10);
  assert.equal(spotifyPosition(s, 3_500), 12.5);
  assert.equal(spotifyPosition(s, 0), 10, "a clock behind the anchor never moves it back");
  assert.equal(spotifyPosition(s, 1_000_000), 180, "capped at the track's length");
  assert.equal(spotifyPosition({ ...s, playing: false }, 60_000), 10, "paused, it stays put");
  assert.equal(spotifyPosition({ ...s, track: null }, 3_000), 12, "no length, no cap");
});

test("a play/pause click freezes or restarts the clock where it is", () => {
  const paused = withPlaying(playing(), false, 5_000);
  assert.equal(paused.playing, false);
  assert.equal(paused.position, 14);
  assert.equal(paused.positionAt, 5_000);
  assert.equal(spotifyPosition(paused, 9_000), 14);
  const again = withPlaying(paused, true, 9_000);
  assert.equal(spotifyPosition(again, 10_000), 15);
  const same = playing();
  assert.equal(withPlaying(same, true, 99), same, "no change, same object");
});

test("times read like the Mac's player", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65.9), "1:05");
  assert.equal(formatTime(599), "9:59");
  assert.equal(formatTime(3725), "1:02:05");
  assert.equal(formatTime(-3), "0:00");
  assert.equal(formatTime(Number.NaN), "0:00");
});

test("the volume icon has the Mac's thresholds", () => {
  assert.deepEqual([0, 1, 33, 34, 66, 67, 100].map(volumeLevel), [0, 1, 1, 2, 2, 3, 3]);
});

test("ads are told by their id", () => {
  assert.ok(isAd(track({ id: "spotify:ad:123" })));
  assert.ok(!isAd(track()));
  assert.ok(!isAd(null));
});

test("a cover shows only on the track it belongs to", () => {
  Spotify.artwork = { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/jpeg;base64,AA" };
  assert.equal(currentArtwork(playing()), "data:image/jpeg;base64,AA");
  assert.equal(currentArtwork(playing({ track: track({ artUrl: "https://i.scdn.co/image/zzz" }) })), null);
  assert.equal(currentArtwork(playing({ track: null })), null);
  Spotify.artwork = null;
});

// ── When the mark dances ──────────────────────────────────────────────────────

test("music counts only when it plays on a declared Spotify pill", () => {
  assert.ok(musicPlaying(playing(), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing(), ["integration_github"]));
  assert.ok(!musicPlaying(playing({ playing: false }), [SPOTIFY_ID]));
  assert.ok(!musicPlaying(playing({ track: null }), [SPOTIFY_ID]));
});

test("the island's Tent dances by the Mac's rules", () => {
  const base = { music: true, state: "idle", mode: "compact", view: "overview", focusId: "integration_claude" };
  // Compact: whenever music plays, in the calm and busy states.
  for (const state of ["idle", "working", "thinking", "searching", "finished"]) {
    assert.ok(islandDances({ ...base, state }), state);
  }
  // An alert, an error, sleep or a daze win.
  for (const state of ["approval", "question", "error", "ratelimit", "sleeping", "dizzy"]) {
    assert.ok(!islandDances({ ...base, state }), state);
  }
  assert.ok(!islandDances({ ...base, music: false }));
  assert.ok(!islandDances({ ...base, mode: "hidden" }));
  // Expanded: only on the overview, with the music pill in front.
  assert.ok(!islandDances({ ...base, mode: "expanded" }));
  assert.ok(islandDances({ ...base, mode: "expanded", focusId: SPOTIFY_ID }));
  assert.ok(!islandDances({ ...base, mode: "expanded", focusId: SPOTIFY_ID, view: "prompt" }));
});

// ── Reports from Rust ─────────────────────────────────────────────────────────

const island = { reveals: 0, revealSilently() { this.reveals += 1; } };
registerSpotifyHandlers(island);

beforeEach(() => {
  setLanguage("en");
  State.settings = { ...DEFAULT_SETTINGS };
  State.os = "linux";
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  useRegistry({ shown: ["spotify"] });
  Spotify.state = { ...IDLE_SPOTIFY };
  Spotify.artwork = null;
  island.reveals = 0;
});

const spotifyTask = () => State.tasks.find((t) => t.id === SPOTIFY_ID);

test("the pill wears the track's title, and its own name when nothing plays", () => {
  assert.equal(spotifyTask().name, "Spotify");
  emit("spotify", playing());
  assert.equal(Spotify.state.track.title, "Get Lucky");
  assert.equal(spotifyTask().name, "Get Lucky");
  emit("spotify", playing({ track: track({ id: "spotify:ad:1", title: "" }) }));
  assert.equal(spotifyTask().name, "Advertisement");
  emit("spotify", { ...IDLE_SPOTIFY, running: true });
  assert.equal(spotifyTask().name, "Spotify");
});

test("music starting shows the hidden island once, silently; nothing on Windows-like setups", () => {
  emit("spotify", playing({ playing: false }));
  assert.equal(island.reveals, 0);
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  emit("spotify", playing({ position: 30 }));
  assert.equal(island.reveals, 1, "only on not playing → playing");
  assert.ok(State.spotifyPlaying);

  // Not declared: nothing dances, nothing shows.
  emit("spotify", { ...IDLE_SPOTIFY });
  useRegistry({ shown: [] });
  emit("spotify", playing());
  assert.equal(island.reveals, 1);
  assert.ok(!State.spotifyPlaying);
});

test("Spotify kept from opening the island never shows it", () => {
  useRegistry({ shown: ["spotify"], builtins: { spotify: { opensIsland: false } } });
  emit("spotify", playing());
  assert.equal(island.reveals, 0);
  assert.ok(State.spotifyPlaying, "it still plays on its pill");
});

test("the cover arrives on its own event", () => {
  emit("spotify", playing());
  emit("spotify-artwork", { artUrl: "https://i.scdn.co/image/abc", dataUrl: "data:image/png;base64,AA" });
  assert.equal(currentArtwork(), "data:image/png;base64,AA");
});

test("the card reads the player again each time it comes on screen", () => {
  const before = sent("spotify_refresh").length;
  State.mode = "expanded";
  State.view = "overview";
  State.setFocus(SPOTIFY_ID);
  assert.equal(sent("spotify_refresh").length, before + 1);
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 1, "not again while it stays");
  State.mode = "compact";
  State.notify();
  State.mode = "expanded";
  State.notify();
  assert.equal(sent("spotify_refresh").length, before + 2);
});

// ── Views ─────────────────────────────────────────────────────────────────────

test("the idle card: not playing, or not installed with a way to get it", () => {
  const card = buildSpotifyCard();
  Spotify.state = { ...IDLE_SPOTIFY, installed: true };
  card.sync();
  assert.match(card.el.textContent, /Spotify.*Integration.*Not playing.*Open Spotify/);
  Spotify.state = { ...IDLE_SPOTIFY };
  card.sync();
  assert.match(card.el.textContent, /Spotify not installed.*Get Spotify/);
  card.el.find("BUTTON")[0].fire("click");
  assert.ok(sent("spotify_open").length > 0);

  setLanguage("fr");
  card.sync();
  assert.ok(card.el.textContent.includes(lookup("Get Spotify", "fr")));
});

test("the playing card: title, artist · album, times, and the controls", () => {
  const card = buildSpotifyCard();
  Spotify.state = playing({ playing: false, shuffle: true });
  card.sync();
  const text = card.el.textContent;
  assert.ok(text.includes("Get Lucky"));
  assert.ok(text.includes("Daft Punk · Random Access Memories"));
  assert.ok(text.includes("0:10") && text.includes("-2:50"));

  const [shuffle, prev, play, next, repeat] = card.el.querySelector("np-buttons").children;
  assert.equal(shuffle.title, "Shuffle on");
  assert.equal(repeat.title, "Repeat off");
  assert.equal(play.title, "Play");
  const before = sent("spotify_control").length;
  shuffle.fire("click");
  repeat.fire("click");
  prev.fire("click");
  next.fire("click");
  play.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [
    { action: "shuffle", value: 0 },
    { action: "repeat", value: 1 },
    { action: "previous", value: null },
    { action: "next", value: null },
    { action: "playPause", value: null },
  ]);
  // The page shows the clicks at once.
  assert.equal(Spotify.state.shuffle, false);
  assert.equal(Spotify.state.repeat, true);
  assert.equal(Spotify.state.playing, true);

  Spotify.state = playing({ track: track({ id: "spotify:ad:9", title: "x", artist: "", album: "" }) });
  card.sync();
  assert.ok(card.el.textContent.includes("Advertisement"));
});

test("the pill shows play/pause and next on hover, only with a track", () => {
  const task = spotifyTask();
  const pill = buildSpotifyPill(task, () => {});
  pill.el.fire("mouseenter");
  assert.ok(!pill.el.classList.contains("controls"), "nothing loaded: no controls");
  Spotify.state = playing();
  pill.sync();
  assert.ok(pill.el.classList.contains("controls"));
  const [playBtn] = pill.el.querySelector("np-pill-controls").children;
  assert.equal(playBtn.title, "Pause");
  const before = sent("spotify_control").length;
  playBtn.fire("click");
  assert.deepEqual(sent("spotify_control").slice(before), [{ action: "playPause", value: null }]);
  assert.equal(Spotify.state.playing, false);
  pill.el.fire("mouseleave");
  assert.ok(!pill.el.classList.contains("controls"));
});

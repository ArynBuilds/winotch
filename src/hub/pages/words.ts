// Words: what dictation must get right. The dictionary (names it always spells
// right), replacements (heard → written) and snippets (say a few words, paste
// a whole text), on one page. Port of FlowHubWords.swift.

import { h, clear } from "../../views/dom";
import { t } from "../../i18n/i18n";
import { FlowBridge, type Replacement, type Snippet } from "../../core/flow";
import type { HubContext } from "../shell";
import { button, icon, iconButton, pageHead, section } from "../ui";

function newId(): string {
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 8)}`;
}

function input(placeholder: string, onEnter?: () => void): HTMLInputElement {
  const el = h("input", { class: "hub-input", placeholder }) as HTMLInputElement;
  if (onEnter) el.addEventListener("keydown", (e) => e.key === "Enter" && onEnter());
  return el;
}

export async function wordsPage(page: HTMLElement, _ctx: HubContext) {
  page.classList.add("narrow");
  page.append(pageHead(t("Words")));
  const [data, snippetList] = await Promise.all([FlowBridge.words(), FlowBridge.snippets()]);
  let words = data?.words ?? [];
  let replacements: Replacement[] = data?.replacements ?? [];
  let snippets: Snippet[] = snippetList ?? [];
  const saveWords = () => void FlowBridge.setWords({ words, replacements });
  const saveSnippets = () => void FlowBridge.setSnippets(snippets);

  // ── Dictionary ──
  const chips = h("div", { class: "hub-chips" });
  const wordInput = input(t("Add a word, e.g. Supabase"), () => addWord());
  wordInput.style.flex = "1";
  const addWord = () => {
    const w = wordInput.value.trim();
    if (!w || words.some((x) => x.toLowerCase() === w.toLowerCase())) return;
    words = [...words, w];
    wordInput.value = "";
    saveWords();
    drawWords();
  };
  const drawWords = () => {
    clear(chips);
    chips.style.display = words.length ? "" : "none";
    for (const w of words) {
      const remove = h("button", { title: t("Delete"), "aria-label": t("Delete") });
      remove.append(icon("x"));
      remove.addEventListener("click", () => {
        words = words.filter((x) => x !== w);
        saveWords();
        drawWords();
      });
      chips.append(h("span", { class: "hub-chip" }, h("span", { text: w }), remove));
    }
  };
  page.append(section(t("Dictionary"), [
    h("div", { class: "hub-row" }, wordInput, button(t("Add"), addWord, "primary", true)),
    chips,
  ], t("Names and words winotch must always spell right.")));
  drawWords();

  // ── Replacements ──
  const list = h("div", {});
  const from = input(t("Heard, e.g. cloud code"));
  const to = input(t("Written, e.g. Claude Code"), () => addReplacement());
  const addReplacement = () => {
    const f = from.value.trim();
    const w = to.value.trim();
    if (!f || !w) return;
    replacements = [...replacements.filter((r) => r.from.toLowerCase() !== f.toLowerCase()), { id: newId(), from: f, to: w }];
    from.value = "";
    to.value = "";
    saveWords();
    drawReplacements();
  };
  const drawReplacements = () => {
    clear(list);
    list.style.display = replacements.length ? "" : "none";
    for (const r of replacements) {
      list.append(h("div", { class: "hub-list-row" },
        h("div", { class: "grow hub-pair" },
          h("span", { text: r.from }),
          h("span", { class: "arrow", text: "→" }),
          h("b", { text: r.to, style: "font-weight:600" }),
          iconButton("trash", t("Delete"), () => {
            replacements = replacements.filter((x) => x.id !== r.id);
            saveWords();
            drawReplacements();
          }),
        ),
      ));
    }
  };
  page.append(section(t("Replacements"), [
    h("div", { class: "hub-pair hub-row" }, from, h("span", { class: "arrow", text: "→" }), to, button(t("Add"), addReplacement, "primary", true)),
    list,
  ], t("When winotch hears the words on the left, it writes the ones on the right.")));
  drawReplacements();

  // ── Snippets ──
  let editing: Snippet | null = null;
  const trigger = h("input", { class: "hub-input", placeholder: t("What you say, e.g. my signature") }) as HTMLInputElement;
  trigger.style.flex = "1";
  const text = h("textarea", { class: "hub-textarea", placeholder: t("The text winotch pastes") }) as HTMLTextAreaElement;
  const cancel = button(t("Cancel"), () => edit(null), "", true);
  const saveButton = button(t("Save"), () => {
    const tr = trigger.value.trim();
    const tx = text.value;
    if (!tr || !tx.trim()) return;
    if (editing) {
      snippets = snippets.map((s) => (s.id === editing!.id ? { ...s, trigger: tr, text: tx } : s));
    } else {
      snippets = [...snippets, { id: newId(), trigger: tr, text: tx }];
    }
    saveSnippets();
    edit(null);
    drawSnippets();
  }, "primary", true);
  const edit = (s: Snippet | null) => {
    editing = s;
    trigger.value = s?.trigger ?? "";
    text.value = s?.text ?? "";
    cancel.style.display = s ? "" : "none";
  };
  const snippetRows = h("div", {});
  const drawSnippets = () => {
    clear(snippetRows);
    snippetRows.style.display = snippets.length ? "" : "none";
    for (const s of snippets) {
      snippetRows.append(h("div", { class: "hub-list-row" },
        h("div", { class: "grow" }, h("div", { style: "font:600 13.5px var(--font)", text: `« ${s.trigger} »` }), h("div", { class: "hub-snippet-text", text: s.text })),
        iconButton("pencil", t("Edit"), () => {
          edit(s);
          trigger.focus();
        }),
        iconButton("trash", t("Delete"), () => {
          snippets = snippets.filter((x) => x.id !== s.id);
          saveSnippets();
          drawSnippets();
        }),
      ));
    }
  };
  page.append(section(t("Snippets"), [
    h("div", { class: "hub-snippet-form" }, trigger, text, h("div", { class: "hub-row", style: "justify-content:flex-end" }, cancel, saveButton)),
    snippetRows,
  ], t("Say the trigger while dictating: winotch pastes the whole text in its place.")));
  edit(null);
  drawSnippets();
}

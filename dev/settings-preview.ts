// The settings inside a real island (?page=welcome|general|claude|apps|voice|dictation|notes|words).
// `npm run dev`, then open /dev/settings-preview.html. Not shipped in the app.

import "../src/style.css";
import { Island } from "../src/island/island";

const island = new Island(document.getElementById("root")!);
island.openSettings(new URLSearchParams(location.search).get("page") ?? "general");

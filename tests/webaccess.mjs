// "Allow web access" switch and footer. Mock LLM scripted per step; checks tools sent, prompt, tool refusal,
// Python network blocking (package servers still allowed), persistence across Python restart, a11y.
import http from "node:http";
import fs from "node:fs";
import { chromium } from "playwright";
import AxeBuilder from "@axe-core/playwright";

let failed = 0;
const expect = (c, m, extra = "") => { console.log((c ? "ok  - " : "FAIL - ") + m + (c ? "" : "  → " + extra)); if (!c) failed++; };
const reqs = [];
let script = [];
const tc = (name, args) => ({ id: "c" + Math.random().toString(36).slice(2, 8), type: "function", function: { name, arguments: JSON.stringify(args) } });
const srv = http.createServer(async (q, r) => {
  if (q.url.startsWith("/v1/chat")) {
    let b = ""; for await (const c of q) b += c;
    reqs.push(JSON.parse(b));
    const m = script.shift() || { content: "done" };
    r.writeHead(200, { "Content-Type": "application/json" });
    return r.end(JSON.stringify({ choices: [{ message: { role: "assistant", ...m } }] }));
  }
  r.writeHead(200, { "Content-Type": "text/html" }); r.end(fs.readFileSync(new URL("../index.html", import.meta.url)));
});
await new Promise(x => srv.listen(8770, x));
const b = await chromium.launch();
const p = await (await b.newContext()).newPage();
p.on("pageerror", e => console.log("[pageerror]", e.message));
const ready = () => p.waitForFunction(() => document.getElementById("pytext").textContent.startsWith("Python ready"), null, { timeout: 180000 });
const lastTool = () => p.locator(".tool .res").last().textContent();
async function ask(text, steps) {
  script = steps;
  const before = await p.locator(".msg.assistant").count();
  await p.fill("#input", text); await p.press("#input", "Enter");
  await p.waitForFunction(n => document.querySelectorAll(".msg.assistant").length > n, before, { timeout: 120000 });
}

try {
  await p.goto("http://localhost:8770/#endpoint=/v1&key=k&model=m");
  await ready();
  const footer = await p.locator("footer").innerText();
  expect(footer.includes("This page uses AI Models hosted at the University of Illinois.") && footer.includes("10 MB and 1.5M tokens per rolling hour"), "footer text shown", footer);
  const sw = p.getByRole("switch", { name: "Allow web access" });
  expect(await sw.isChecked(), "switch is on by default");

  await ask("hi", [{ content: "hello" }]);
  expect(reqs.at(-1).tools.length === 6, "web on: 6 tools sent", reqs.at(-1).tools.length);

  await sw.focus(); await p.keyboard.press("Space");
  expect(!(await sw.isChecked()), "switch toggles off with the keyboard");
  expect((await p.innerText("#chat")).includes("Web access turned off"), "chat notes the change");

  await ask("get example.com", [
    { content: "", tool_calls: [tc("fetch_url", { url: "https://example.com/" })] },
    { content: "", tool_calls: [tc("run_python", { code: "from pyodide.http import pyfetch\ntry:\n    await pyfetch('https://example.com/')\nexcept Exception as e:\n    print('BLOCKED:', e)" })] },
    { content: "", tool_calls: [tc("run_python", { code: "import micropip\nawait micropip.install('tabulate')\nimport tabulate\nprint('pkg ok', tabulate.__version__)" })] },
    { content: "ok" },
  ]);
  const offReq = reqs.at(-4);
  const names = offReq.tools.map(t => t.function.name);
  expect(names.length === 4 && !names.includes("web_search") && !names.includes("fetch_url"), "web off: web tools not offered", names.join(","));
  expect(offReq.messages[0].content.includes("Web access is turned OFF"), "web off: system prompt says so");
  const res = await p.locator(".tool .res").allTextContents();
  expect(res.at(-3).startsWith("ERROR: Web access is turned off"), "fetch_url refused even if the model calls it", res.at(-3));
  expect(/BLOCKED:.*Web access is turned off/.test(res.at(-2)), "Python network access blocked", res.at(-2));
  expect(res.at(-1).includes("pkg ok"), "Python packages can still be installed (package servers allowed)", res.at(-1));

  await p.click("#restartpy"); await ready();
  await ask("again", [
    { content: "", tool_calls: [tc("run_python", { code: "from pyodide.http import pyfetch\ntry:\n    await pyfetch('https://example.com/')\nexcept Exception as e:\n    print('BLOCKED:', e)" })] },
    { content: "ok" },
  ]);
  expect(/Web access is turned off/.test(await lastTool()), "still blocked after Python restart", await lastTool());

  await p.reload(); await ready();
  expect(!(await p.getByRole("switch", { name: "Allow web access" }).isChecked()), "off setting remembered after reload");

  await p.locator("label.switch").click(); // what a mouse user clicks
  expect(await p.getByRole("switch", { name: "Allow web access" }).isChecked(), "clicking the visible switch turns it on");
  await ask("on again", [
    { content: "", tool_calls: [tc("run_python", { code: "from pyodide.http import pyfetch\ntry:\n    r = await pyfetch('https://cdn.jsdelivr.net/pyodide/v0.27.7/full/pyodide-lock.json')\n    print('status', r.status)\nexcept Exception as e:\n    print('ERR:', e)\ntry:\n    await pyfetch('https://example.com/')\nexcept Exception as e:\n    print('OTHER:', e)" })] },
    { content: "ok" },
  ]);
  const onRes = await lastTool();
  expect(reqs.at(-2).tools.length === 6 && !/turned off/.test(onRes), "web on again: tools restored and no block message", onRes);

  const axe = await new AxeBuilder({ page: p }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"]).analyze();
  expect(axe.violations.length === 0, "axe: 0 violations with switch and footer", axe.violations.map(v => v.id + ": " + v.nodes.map(n => n.target).join(" ")).join("; "));
  await p.setViewportSize({ width: 320, height: 700 });
  expect(!(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1)), "no horizontal overflow at 320px");
  await p.setViewportSize({ width: 1280, height: 720 });
  const fb = await p.locator("footer").boundingBox();
  expect(fb && fb.y + fb.height <= 721 && fb.y > 600, "footer pinned at the bottom of the window on desktop", JSON.stringify(fb));
  await p.screenshot({ path: "/private/tmp/claude-502/-Users-angrave-2026-smallprojects-agenticchat/db23fa03-8905-4ea3-b471-57d0ee48a6d8/scratchpad/shot_web.png" });
} catch (e) {
  failed++; console.log("FAIL - exception:", e.message);
} finally {
  await b.close(); srv.close();
}
console.log(failed ? `${failed} FAILED` : "ALL WEB ACCESS TESTS PASSED");
process.exit(failed ? 1 : 0);

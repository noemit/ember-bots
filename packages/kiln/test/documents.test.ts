import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { AgentDoc, createRegistry, Harness, type ConversationId, type Harness as HarnessType, type JsonObject } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { Approvals, setAutoAccept } from "../src/approvals";
import { hearthCodemodeExtensions } from "../src/codemode";
import { hearthConfig } from "../src/config";
import { FileCredentialStore } from "../src/credentials";
import { isSecretPath, MAX_DOC_BYTES, MAX_RESOLVE_CANDIDATES } from "../src/documents";
import { scratchDirFor } from "../src/scratch";
import { startHearthServer, type HearthServer } from "../src/server";
import { View } from "../src/view";

const context = BACKGROUND_CONTEXT;
const TOKEN = "doc-test-token-0123456789abcdef0123456789abcdef";

const toolCall = (name: string, args: JsonObject) =>
  fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" });

// 1x1 valid transparent PNG.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64"
);

const LEAKS = ["<html", "node_modules", "at async ", "\n    at ", "C:\\", "hearth-audit", "/workspace/", "pid"];

describe("Kiln documents resolution, provenance & containment", () => {
  let rootTemp: string;
  let hearthHome: string;
  let projectDir: string;
  let outsideDir: string;
  let homeSubdirForWideTest: string;
  let storage: Awaited<ReturnType<typeof openNodeSqliteStorage>>;
  let harness: HarnessType;
  let server: HearthServer;
  let faux: ReturnType<typeof fauxProvider>;
  let codemodeClose: () => void;

  const api = (path: string, init?: RequestInit) =>
    fetch(`${server.url}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
        ...(init?.headers ?? {}),
      },
    });

  beforeAll(async () => {
    rootTemp = mkdtempSync(join(tmpdir(), "kiln-docs-test-"));
    hearthHome = join(rootTemp, "hearth-home");
    projectDir = join(rootTemp, "project");
    outsideDir = join(rootTemp, "outside");
    mkdirSync(hearthHome, { recursive: true });
    mkdirSync(join(projectDir, "docs", "nested", "a", "b", "c"), { recursive: true });
    mkdirSync(join(projectDir, "node_modules", "pkg"), { recursive: true });
    mkdirSync(join(projectDir, ".git", "hooks"), { recursive: true });
    mkdirSync(join(projectDir, ".hidden"), { recursive: true });
    mkdirSync(join(projectDir, "dup-a"), { recursive: true });
    mkdirSync(join(projectDir, "dup-b"), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    // Clean files in projectDir
    writeFileSync(join(projectDir, "README.md"), "# Project Root\nSee [Guide](docs/guide.md#intro).\n");
    writeFileSync(join(projectDir, "keyboard.md"), "# Keyboard shortcuts\n");
    writeFileSync(join(projectDir, "api-keys.md"), "# API key docs\n");
    writeFileSync(join(projectDir, "docs", "guide.md"), "# Guide\n\n## Intro\nRelative link: [Deep](nested/deep.html)\n");
    writeFileSync(join(projectDir, "docs", "My Notes.md"), "# My Notes\n\nLine 3\nLine 4\nLine 5\n");
    writeFileSync(join(projectDir, "docs", "nested", "deep.html"), "<html><body><h1>Deep HTML</h1></body></html>");
    writeFileSync(
      join(projectDir, "docs", "nested", "a", "b", "c", "too-deep.md"),
      "# Beyond depth 4\n"
    );
    writeFileSync(join(projectDir, "node_modules", "pkg", "mod.md"), "# Skip node_modules\n");
    writeFileSync(join(projectDir, ".hidden", "hidden.md"), "# Hidden dir\n");
    writeFileSync(join(projectDir, ".git", "notes.md"), "# Git internal\n");
    writeFileSync(join(projectDir, "dup-a", "dup.md"), "# Dup A\n");
    writeFileSync(join(projectDir, "dup-b", "dup.md"), "# Dup B\n");
    writeFileSync(join(projectDir, "docs", "escape-link.md"), "Attempt [Outside](../../../outside/secret.md)\n");

    // Secret-named & unsafe files inside projectDir
    writeFileSync(join(projectDir, ".env"), "SECRET=1\n");
    writeFileSync(join(projectDir, ".env.local.md"), "SECRET=2\n");
    writeFileSync(join(projectDir, ".ENV.MD"), "SECRET=3\n");
    writeFileSync(join(projectDir, "cert.pem"), "CERT\n");
    writeFileSync(join(projectDir, "priv.pem.md"), "KEY\n");
    writeFileSync(join(projectDir, "server.key.md"), "KEY\n");
    writeFileSync(join(projectDir, "id_rsa.md"), "SSH KEY\n");
    writeFileSync(join(projectDir, "id_ed25519.html"), "<html>SSH KEY</html>");
    mkdirSync(join(projectDir, ".ssh"), { recursive: true });
    writeFileSync(join(projectDir, ".ssh", "notes.md"), "SSH\n");
    mkdirSync(join(projectDir, ".config", "gh"), { recursive: true });
    writeFileSync(join(projectDir, ".config", "gh", "hosts.md"), "TOKEN\n");
    writeFileSync(join(projectDir, ".config", "gh", "auth.json"), "{}");
    mkdirSync(join(projectDir, ".config", "app"), { recursive: true });
    writeFileSync(join(projectDir, ".config", "app", "settings.json.md"), "CONF\n");
    writeFileSync(join(projectDir, "notes.txt"), "Not md or html\n");
    writeFileSync(join(projectDir, "big.md"), "x".repeat(MAX_DOC_BYTES + 32));
    writeFileSync(join(projectDir, "binary.md"), Buffer.from([0x23, 0x20, 0x00, 0x41]));
    writeFileSync(join(projectDir, "badutf8.md"), Buffer.from([0xff, 0xfe, 0x80, 0x81]));
    mkdirSync(join(projectDir, "dir-as-doc.md"), { recursive: true });
    symlinkSync(join(outsideDir, "secret.md"), join(projectDir, "symlink-escape.md"));
    symlinkSync(join(projectDir, "README.md"), join(projectDir, "symlink-internal.md"));
    try {
      execFileSync("mkfifo", [join(projectDir, "pipe.md")]);
    } catch {
      // Optional on platforms without mkfifo.
    }

    // Outside files
    writeFileSync(join(outsideDir, "secret.md"), "# Secret outside project\n");
    writeFileSync(join(outsideDir, "evidenced.md"), "# Evidenced artifact\n[Rel](./sibling-outside.md)\n");
    writeFileSync(join(outsideDir, "sibling-outside.md"), "# Sibling outside\n");
    writeFileSync(join(outsideDir, "image.png"), TINY_PNG);

    // Wide-root probe file under actual homedir ONLY under a temp subdir inside homedir, cleaned in afterAll
    homeSubdirForWideTest = mkdtempSync(join(homedir(), ".kiln-wide-probe-"));
    // Place an explicit file inside real homedir ONLY via temp dir is subdir; also test cwd = homedir directly without writing in homedir root!
    // Wait: we can also test `configHome` as a wide root without polluting user's real ~/ !
    writeFileSync(join(hearthHome, "ambient.md"), "# Ambient in config home\n");

    faux = fauxProvider();
    faux.setResponses([fauxAssistantMessage([fauxText("Idle.")])]);
    const models = createModels();
    models.setProvider(faux.provider);

    const registry = createRegistry();
    const cm = hearthCodemodeExtensions({ env: {} });
    codemodeClose = cm.close;
    for (const ext of cm.extensions) registry.install(ext);
    registry.install(CodingTools);
    registry.install(View);
    registry.install(Approvals);

    storage = await openNodeSqliteStorage(join(hearthHome, "hearth.sqlite"));
    harness = await Harness.open(
      storage,
      {
        models,
        registry,
        env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? projectDir }),
      },
      context
    );
    harness.resume();

    server = startHearthServer({
      config: hearthConfig({ home: hearthHome, port: 0, workspace: projectDir }),
      token: TOKEN,
      storage,
      harness,
      models,
      defaultAgent: { model: { provider: "faux", modelId: "faux-1" } },
      store: new FileCredentialStore(join(hearthHome, "auth.json")),
      version: "1.0.0",
      build: "docstest",
    });
  });

  afterAll(async () => {
    await server?.close();
    await harness?.close(context);
    codemodeClose?.();
    rmSync(homeSubdirForWideTest, { recursive: true, force: true });
    rmSync(rootTemp, { recursive: true, force: true });
  });

  test("file tool provenance records on read/write/edit/view/codemode, preserves details, and skips failed/bash calls", async () => {
    const editedPath = join(projectDir, "edited-doc.md");
    writeFileSync(editedPath, "hello old world\n");
    const writtenPath = join(outsideDir, "created-by-tool.html");
    const codemodeReadPath = join(outsideDir, "cm-read.md");
    writeFileSync(codemodeReadPath, "# From codemode\n");
    const missingPath = join(outsideDir, "does-not-exist.md");

    faux.setResponses([
      toolCall("read", { path: "README.md" }),
      toolCall("write", { path: writtenPath, content: "<html><body><h1>Written</h1></body></html>" }),
      toolCall("edit", {
        path: "edited-doc.md",
        edits: [{ oldText: "hello old world", newText: "hello new world" }],
      }),
      toolCall("view", { path: join(outsideDir, "image.png") }),
      toolCall("read", { path: missingPath }),
      toolCall("bash", { command: `cat ${JSON.stringify(join(outsideDir, "secret.md"))}` }),
      toolCall("codemode", {
        code: [
          `await tools.read({ path: ${JSON.stringify(codemodeReadPath)} });`,
          `try { await tools.read({ path: ${JSON.stringify(missingPath)} }); } catch {}`,
          `text("ok");`,
        ].join("\n"),
      }),
      fauxAssistantMessage([fauxText(`Done. Also mentioning ${join(outsideDir, "secret.md")} in prose.`)]),
    ]);

    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } } },
      context
    );
    await setAutoAccept(harness, conv.id, true, context);
    const sub = await conv.submit({ type: "input", content: "run file tools" }, context);
    await sub.wait(context);

    const page = await conv.entries({}, 50, undefined, context);
    const toolResults = page.items.filter((e) => e.kind === "pi.tool-result");
    expect(toolResults.length).toBeGreaterThanOrEqual(7);

    const findTool = (name: string) =>
      toolResults
        .map((e) => e.model?.[0] as { toolName?: string; isError?: boolean; details?: Record<string, any> })
        .filter((m) => m?.toolName === name);

    const readRes = findTool("read");
    const okRead = readRes.find((m) => !m.isError)!;
    expect(okRead.details?.provenance).toEqual({
      absolutePath: realpathSync(join(projectDir, "README.md")),
      cwd: projectDir,
    });
    const failedRead = readRes.find((m) => m.isError)!;
    expect(failedRead.details?.provenance).toBeUndefined();

    const writeRes = findTool("write")[0]!;
    expect(writeRes.details?.provenance).toEqual({
      absolutePath: realpathSync(writtenPath),
      cwd: projectDir,
    });

    const editRes = findTool("edit")[0]!;
    expect(typeof editRes.details?.diff).toBe("string");
    expect(typeof editRes.details?.patch).toBe("string");
    expect(editRes.details?.firstChangedLine).toBe(1);
    expect(editRes.details?.provenance).toEqual({
      absolutePath: realpathSync(editedPath),
      cwd: projectDir,
    });

    const viewRes = findTool("view")[0]!;
    expect(viewRes.details?.provenance).toEqual({
      absolutePath: realpathSync(join(outsideDir, "image.png")),
      cwd: projectDir,
    });

    const bashRes = findTool("bash")[0]!;
    expect(bashRes.details?.provenance).toBeUndefined();

    const cmRes = findTool("codemode")[0]!;
    expect(cmRes.isError).toBe(false);
    expect(Array.isArray(cmRes.details?.calls)).toBe(true);
    expect(cmRes.details?.nestedProvenance).toEqual([
      {
        callId: expect.any(String),
        tool: "read",
        absolutePath: realpathSync(codemodeReadPath),
        cwd: projectDir,
      },
    ]);

    // Now verify resolve endpoint honours tool provenance and NEVER infers from bash/prose:
    const res = await api(`/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({
        candidates: [
          "README.md",
          "created-by-tool.html", // outside cwd, resolved via provenance!
          "cm-read.md", // outside cwd, resolved via nested codemode provenance!
          "secret.md", // mentioned in bash and prose, NEVER evidenced!
          missingPath,
        ],
      }),
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { resolved: Array<{ candidate: string; resolvedPath: string; kind: string }> };
    expect(data.resolved.map((item) => item.candidate).sort()).toEqual([
      "README.md",
      "cm-read.md",
      "created-by-tool.html",
    ]);
  }, 60_000);

  test("resolution order, basePath relative containment, duplicate basenames & scratch isolation", async () => {
    // Conv 1 reads outsideDir/evidenced.md and writes own scratch doc
    const conv1IdNum = Number(
      (
        (await api("/conversations", {
          method: "POST",
          body: JSON.stringify({ title: "Conv 1", cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } }),
        }).then((r) => r.json())) as { id: number }
      ).id
    );
    const conv1 = conv1IdNum as ConversationId;
    await setAutoAccept(harness, conv1, true, context);

    const conv1Scratch = scratchDirFor(hearthHome, conv1IdNum);
    const conv2IdNum = Number(
      (
        (await api("/conversations", {
          method: "POST",
          body: JSON.stringify({ title: "Conv 2", cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } }),
        }).then((r) => r.json())) as { id: number }
      ).id
    );
    const conv2Scratch = scratchDirFor(hearthHome, conv2IdNum);
    mkdirSync(conv1Scratch, { recursive: true });
    mkdirSync(conv2Scratch, { recursive: true });
    const scratch1File = join(conv1Scratch, "own-scratch.html");
    const scratch1Child = join(conv1Scratch, "child-scratch.md");
    const scratch2File = join(conv2Scratch, "other-scratch.md");
    writeFileSync(scratch1File, "<html><body>Scratch 1</body></html>");
    writeFileSync(scratch1Child, "# Child scratch\n");
    writeFileSync(scratch2File, "# Sibling scratch\n");

    faux.setResponses([
      toolCall("read", { path: join(outsideDir, "evidenced.md") }),
      fauxAssistantMessage([fauxText("Ready.")]),
    ]);
    const handle1 = await harness.conversation(conv1, context);
    await (await handle1!.submit({ type: "input", content: "read evidenced" }, context)).wait(context);

    // Ambiguous duplicates in project dir + depth limit + skip dirs
    const resolveRes = await api(`/conversations/${conv1IdNum}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({
        candidates: [
          "README.md",
          "docs/guide.md#intro",
          "dup.md", // dup-a/dup.md and dup-b/dup.md -> ambiguous -> omitted
          "dup-a/dup.md", // explicit -> allowed
          "evidenced.md", // provenance
          "too-deep.md", // depth > 4 -> omitted
          "mod.md", // inside node_modules -> omitted
          "hidden.md", // inside .hidden -> omitted
          scratch1File, // own scratch -> allowed
          scratch2File, // sibling conversation scratch -> omitted
          "symlink-internal.md", // inside cwd -> allowed
          "symlink-escape.md", // outside cwd -> omitted
          "keyboard.md",
          "api-keys.md",
        ],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const body = (await resolveRes.json()) as { resolved: Array<{ candidate: string; resolvedPath: string }> };
    expect(body.resolved.map((r) => r.candidate).sort()).toEqual(
      [
        "README.md",
        "api-keys.md",
        "docs/guide.md#intro",
        "dup-a/dup.md",
        "evidenced.md",
        "keyboard.md",
        scratch1File,
        "symlink-internal.md",
      ].sort()
    );

    // Relative links from basePath = docs/guide.md
    const baseGuide = realpathSync(join(projectDir, "docs", "guide.md"));
    const relOk = await api(`/conversations/${conv1IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "nested/deep.html", basePath: baseGuide }),
    });
    expect(relOk.status).toBe(200);
    expect(((await relOk.json()) as { path: string }).path).toBe(
      realpathSync(join(projectDir, "docs", "nested", "deep.html"))
    );

    // Traversal out of cwd via basePath -> 403
    const relEscape = await api(`/conversations/${conv1IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "../../outside/secret.md", basePath: baseGuide }),
    });
    expect(relEscape.status).toBe(403);

    // Relative link from own scratch doc -> child inside same conversation scratch works
    const scratchRelOk = await api(`/conversations/${conv1IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "./child-scratch.md", basePath: realpathSync(scratch1File) }),
    });
    expect(scratchRelOk.status).toBe(200);

    // Relative link from external evidenced.md -> un-evidenced sibling outside cwd/scratch -> 403
    const extUnproven = await api(`/conversations/${conv1IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "./sibling-outside.md", basePath: realpathSync(join(outsideDir, "evidenced.md")) }),
    });
    expect(extUnproven.status).toBe(403);

    // External evidenced.md trying ../ -> 403
    const extEscape = await api(`/conversations/${conv1IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "../project/secret.md", basePath: realpathSync(join(outsideDir, "evidenced.md")) }),
    });
    expect(extEscape.status).toBe(403);

    // Cross-conversation isolation: conv2 cannot read evidenced.md or scratch1File!
    const crossRead1 = await api(`/conversations/${conv2IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: scratch1File }),
    });
    expect(crossRead1.status).toBe(403);
    const crossRead2 = await api(`/conversations/${conv2IdNum}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "evidenced.md" }),
    });
    expect(crossRead2.status).toBe(404);
  }, 60_000);

  test("duplicate provenance basenames reject ambiguously and do not fall back to walk", async () => {
    const file1 = join(outsideDir, "p1", "report.md");
    const file2 = join(outsideDir, "p2", "report.md");
    mkdirSync(join(outsideDir, "p1"), { recursive: true });
    mkdirSync(join(outsideDir, "p2"), { recursive: true });
    writeFileSync(file1, "# P1\n");
    writeFileSync(file2, "# P2\n");
    writeFileSync(join(projectDir, "report.md"), "# In cwd\n");

    faux.setResponses([
      toolCall("read", { path: file1 }),
      toolCall("read", { path: file2 }),
      fauxAssistantMessage([fauxText("Read both reports.")]),
    ]);
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } } },
      context
    );
    await setAutoAccept(harness, conv.id, true, context);
    await (await conv.submit({ type: "input", content: "read duplicates" }, context)).wait(context);

    const resolveRes = await api(`/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({ candidates: ["report.md", file1, file2] }),
    });
    expect(resolveRes.status).toBe(200);
    const { resolved } = (await resolveRes.json()) as { resolved: Array<{ candidate: string }> };
    expect(resolved.map((r) => r.candidate).sort()).toEqual([file1, file2].sort());

    const readAmb = await api(`/conversations/${conv.id}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "report.md" }),
    });
    expect(readAmb.status).toBe(403);
  }, 60_000);

  test("wide-root guard disables walk for / and homedir and config.home while allowing explicit provenance", async () => {
    const allowedInOutside = join(outsideDir, "wide-allowed.md");
    writeFileSync(allowedInOutside, "# Provenance allowed under wide cwd\n");

    for (const wideCwd of ["/", homedir(), "/tmp", hearthHome]) {
      faux.setResponses([
        toolCall("read", { path: allowedInOutside }),
        fauxAssistantMessage([fauxText("Wide root test.")]),
      ]);
      const conv = await harness.createConversation(
        { ownership: { kind: "ownerless" }, agent: { cwd: wideCwd, model: { provider: "faux", modelId: "faux-1" } } },
        context
      );
      await setAutoAccept(harness, conv.id, true, context);
      await (await conv.submit({ type: "input", content: "read one" }, context)).wait(context);

      const resolveRes = await api(`/conversations/${conv.id}/documents/resolve`, {
        method: "POST",
        body: JSON.stringify({ candidates: ["wide-allowed.md", "ambient.md"] }),
      });
      expect(resolveRes.status).toBe(200);
      const { resolved } = (await resolveRes.json()) as { resolved: Array<{ candidate: string }> };
      expect(resolved.map((r) => r.candidate)).toEqual(["wide-allowed.md"]);
    }
  }, 60_000);

  test("secret denylist, special files, binary/UTF-8, size limit, auth, origin, and error boundaries", async () => {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } } },
      context
    );

    const deniedPaths = [
      join(hearthHome, "hearth.token"),
      join(hearthHome, "hearth.sqlite"),
      join(projectDir, ".env"),
      join(projectDir, ".env.local.md"),
      join(projectDir, ".ENV.MD"),
      join(projectDir, "cert.pem"),
      join(projectDir, "priv.pem.md"),
      join(projectDir, "server.key.md"),
      join(projectDir, "id_rsa.md"),
      join(projectDir, "id_ed25519.html"),
      join(projectDir, ".ssh", "notes.md"),
      join(projectDir, ".config", "gh", "hosts.md"),
      join(projectDir, ".config", "app", "settings.json.md"),
      join(projectDir, ".git", "notes.md"),
      join(projectDir, "notes.txt"),
      join(projectDir, "symlink-escape.md"),
      join(projectDir, "dir-as-doc.md"),
      join(outsideDir, "secret.md"),
      "file:///etc/passwd.md",
      `file://${join(outsideDir, "secret.md")}`,
      `file://evil-host${join(projectDir, "README.md")}`,
      `file:////evil-host/share/README.md`,
      `file://localhost//evil-host/share/README.md`,
      `file://user:pass@localhost${join(projectDir, "README.md")}`,
      `file://${join(projectDir, "README.md")}?raw=1`,
      `file://${join(projectDir, "docs")}/../outside/secret.md`,
      `file://${join(projectDir, "docs")}/%2e%2e/outside/secret.md`,
      `file://${join(projectDir, "README")}%00.md`,
      `file://${join(projectDir, ".env.local.md")}`,
      `file://${join(projectDir, "symlink-escape.md")}`,
    ];

    for (const target of deniedPaths) {
      const res = await api(`/conversations/${conv.id}/documents/read`, {
        method: "POST",
        body: JSON.stringify({ path: target }),
      });
      expect(res.status).toBe(403);
      const text = await res.text();
      for (const leak of LEAKS) expect(text).not.toContain(leak);
    }

    // Size > 2 MiB -> 413
    const bigRes = await api(`/conversations/${conv.id}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "big.md" }),
    });
    expect(bigRes.status).toBe(413);

    // Binary & invalid UTF-8 -> 400
    const binRes = await api(`/conversations/${conv.id}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "binary.md" }),
    });
    expect(binRes.status).toBe(400);

    const utf8Res = await api(`/conversations/${conv.id}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: "badutf8.md" }),
    });
    expect(utf8Res.status).toBe(400);

    // FIFO pipe (nonblocking reject) -> 403 when addressed explicitly
    if (existsSyncSafe(join(projectDir, "pipe.md"))) {
      const fifoRes = await api(`/conversations/${conv.id}/documents/read`, {
        method: "POST",
        body: JSON.stringify({ path: "./pipe.md" }),
      });
      expect(fifoRes.status).toBe(403);
    }

    // Too many candidates -> 400
    const tooMany = Array.from({ length: MAX_RESOLVE_CANDIDATES + 1 }, (_, i) => `doc-${i}.md`);
    const capRes = await api(`/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({ candidates: tooMany }),
    });
    expect(capRes.status).toBe(400);

    // Auth required -> 401
    const unauth = await fetch(`${server.url}/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ candidates: ["README.md"] }),
    });
    expect(unauth.status).toBe(401);

    // Origin blocked -> 403
    const crossOrigin = await fetch(`${server.url}/conversations/${conv.id}/documents/read`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        origin: "https://evil.example",
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: "README.md" }),
    });
    expect(crossOrigin.status).toBe(403);

    // Wrong HTTP method -> 404 wording from CONVERSATION_ACTIONS
    const wrongMethod = await api(`/conversations/${conv.id}/documents/resolve`, { method: "GET" });
    expect(wrongMethod.status).toBe(404);
    const wrongJson = (await wrongMethod.json()) as { error: string };
    expect(wrongJson.error).toContain("POST");
  });

  test("bounded project walk stops after 2,000 visited entries", async () => {
    const crowdedDir = join(rootTemp, "crowded-project");
    mkdirSync(join(crowdedDir, "zzz-last"), { recursive: true });
    // Create > 2,000 entries alphabetically before zzz-last so the bounded index hits its limit.
    for (let i = 0; i < 2_050; i += 1) {
      writeFileSync(join(crowdedDir, `a-${String(i).padStart(4, "0")}.txt`), "noise");
    }
    writeFileSync(join(crowdedDir, "zzz-last", "late.md"), "# Beyond 2,000 entries\n");

    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: crowdedDir, model: { provider: "faux", modelId: "faux-1" } } },
      context
    );
    const res = await api(`/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({ candidates: ["late.md", "zzz-last/late.md"] }),
    });
    expect(res.status).toBe(200);
    const { resolved } = (await res.json()) as { resolved: Array<{ candidate: string }> };
    // Explicit path zzz-last/late.md resolves via step (b), while bare basename late.md is bounded out of step (d).
    expect(resolved.map((r) => r.candidate)).toEqual(["zzz-last/late.md"]);
  });

  test("local file:// URLs, %20 spaces, #L line fragments, and ./relative.md paths enforce full containment", async () => {
    const conv = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: { cwd: projectDir, model: { provider: "faux", modelId: "faux-1" } } },
      context
    );

    const fileUrlReadme = `file://${join(projectDir, "README.md")}`;
    const fileUrlNotes = `file://localhost${join(projectDir, "docs", "My%20Notes.md")}#L3-L5`;
    const fileUrlOutside = `file://${join(outsideDir, "secret.md")}`;
    const fileUrlWide = `file://${join(hearthHome, "ambient.md")}`;

    const resolveRes = await api(`/conversations/${conv.id}/documents/resolve`, {
      method: "POST",
      body: JSON.stringify({
        candidates: [
          "./README.md",
          "README.md",
          "docs/My Notes.md#L3-L5",
          fileUrlReadme,
          fileUrlNotes,
          fileUrlOutside,
          fileUrlWide,
          `file://evil-host${join(projectDir, "README.md")}`,
          `file://${join(projectDir, "docs")}/%2e%2e/outside/secret.md`,
        ],
      }),
    });
    expect(resolveRes.status).toBe(200);
    const { resolved } = (await resolveRes.json()) as {
      resolved: Array<{ candidate: string; resolvedPath: string }>;
    };
    expect(resolved.map((item) => item.candidate).sort()).toEqual(
      [
        "./README.md",
        "README.md",
        "docs/My Notes.md#L3-L5",
        fileUrlNotes,
        fileUrlReadme,
      ].sort()
    );

    const readNotes = await api(`/conversations/${conv.id}/documents/read`, {
      method: "POST",
      body: JSON.stringify({ path: fileUrlNotes }),
    });
    expect(readNotes.status).toBe(200);
    const doc = (await readNotes.json()) as { path: string; content: string };
    expect(doc.path).toBe(realpathSync(join(projectDir, "docs", "My Notes.md")));
    expect(doc.content).toContain("Line 3");
  });

  test("allows ordinary scratch reports under default .ember and .hearth homes while still blocking secrets and other chats", () => {
    for (const defaultName of [".ember", ".hearth"]) {
      const configHome = join(rootTemp, "fake-home", defaultName);
      const ownScratch = scratchDirFor(configHome, 7);
      const otherScratch = scratchDirFor(configHome, 8);
      mkdirSync(ownScratch, { recursive: true });
      mkdirSync(otherScratch, { recursive: true });

      expect(isSecretPath(join(ownScratch, "report.md"), configHome, 7)).toBe(false);
      expect(isSecretPath(join(ownScratch, "nested", "summary.html"), configHome, 7)).toBe(false);

      // Still deny secret descendants inside own scratch.
      expect(isSecretPath(join(ownScratch, ".env"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(ownScratch, ".env.local.md"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(ownScratch, "sub", ".ember", "leak.md"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(ownScratch, "sub", ".ssh", "id_rsa"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(ownScratch, "hearth.sqlite"), configHome, 7)).toBe(true);

      // Still deny cross-conversation scratch and config-home state files.
      expect(isSecretPath(join(otherScratch, "report.md"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(configHome, "settings.json"), configHome, 7)).toBe(true);
      expect(isSecretPath(join(configHome, "auth.json"), configHome, 7)).toBe(true);
    }

    // Even when configHome is literally ~/.ember (the default desktop Kiln home), own scratch is allowed.
    const realDefaultEmber = join(homedir(), ".ember");
    const realOwnScratch = scratchDirFor(realDefaultEmber, 42);
    expect(isSecretPath(join(realOwnScratch, "report.md"), realDefaultEmber, 42)).toBe(false);
    expect(isSecretPath(join(realDefaultEmber, "settings.json"), realDefaultEmber, 42)).toBe(true);
    expect(isSecretPath(join(scratchDirFor(realDefaultEmber, 43), "report.md"), realDefaultEmber, 42)).toBe(true);
  });
});

function existsSyncSafe(target: string): boolean {
  try {
    chmodSync(target, 0o600);
    return true;
  } catch {
    return false;
  }
}

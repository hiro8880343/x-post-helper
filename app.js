"use strict";

const DATA_URL = "https://api.github.com/repos/hiro8880343/x-post-helper/contents/bundle.enc?ref=data";

/* ---------- 保存 (IndexedDB) ---------- */
let dbPromise;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open("x-helper", 1);
    req.onupgradeneeded = () => req.result.createObjectStore("kv");
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}
async function kvGet(key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const req = d.transaction("kv").objectStore("kv").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvSet(key, value) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction("kv", "readwrite");
    tx.objectStore("kv").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/* ---------- 状態 ---------- */
const state = {
  key: null,        // CryptoKey の元になる base64url 文字列
  handle: "",       // X の ID
  bundle: null,     // { created, sets: [...] }
  done: {},         // id -> 完了日時 (受信し直しても残る = 二重投稿防止)
  step: {},         // id -> 1 | 2 | 3
  etag: "",
  justConnected: false,
  syncing: false,
};

async function loadState() {
  for (const name of ["key", "handle", "bundle", "done", "step", "etag"]) {
    const value = await kvGet(name);
    if (value !== undefined) state[name] = value;
  }
}

/* ---------- 部品 ---------- */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else node[k] = v;
  }
  node.append(...children.filter((c) => c !== null && c !== undefined));
  return node;
}
let toastTimer;
function toast(message) {
  const t = document.getElementById("toast");
  t.textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
function b64urlToBytes(s) {
  return b64ToBytes(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
}
const blobCache = new Map();
function imageUrl(set) {
  if (!blobCache.has(set.id)) {
    const blob = new Blob([b64ToBytes(set.image.data)], { type: set.image.mime });
    blobCache.set(set.id, URL.createObjectURL(blob));
  }
  return blobCache.get(set.id);
}

/* ---------- 受信 ---------- */
async function decrypt(buffer) {
  const key = await crypto.subtle.importKey("raw", b64urlToBytes(state.key), "AES-GCM", false, ["decrypt"]);
  const bytes = new Uint8Array(buffer);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.slice(0, 12) }, key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

async function sync(manual) {
  if (!state.key || state.syncing) return;
  state.syncing = true;
  const errorBefore = state.syncError;
  let changed = false;
  renderSyncButton();
  // 入力中や操作中に画面を作り直さないよう、変化があったときだけ描き直す
  if (!state.bundle && state.handle) render();
  try {
    const headers = { Accept: "application/vnd.github.raw+json" };
    if (state.etag && state.bundle) headers["If-None-Match"] = state.etag;
    const res = await fetch(window.__DATA_URL || DATA_URL, { headers, cache: "no-store" });
    if (res.status === 304) {
      if (manual) toast("新しいデータはありません");
    } else if (res.status === 404) {
      if (manual) toast("まだ PC から何も送られていません");
    } else if (!res.ok) {
      throw new Error(`受信に失敗しました (${res.status})。少し待ってからもう一度お試しください。`);
    } else {
      let bundle;
      try {
        bundle = await decrypt(await res.arrayBuffer());
      } catch {
        throw new Error("データを開けませんでした。PC の「スマホと接続」の QR コードを読み取り直してください。");
      }
      const isNew = !state.bundle || bundle.created !== state.bundle.created;
      changed = isNew;
      state.bundle = bundle;
      state.etag = res.headers.get("ETag") || "";
      await kvSet("bundle", bundle);
      await kvSet("etag", state.etag);
      if (isNew) toast(`${bundle.sets.length} セットを受け取りました`);
    }
    state.syncError = "";
  } catch (e) {
    state.syncError = e.message.includes("Failed to fetch")
      ? "インターネットにつながりません。保存済みのデータを表示しています。" : e.message;
  } finally {
    state.syncing = false;
    renderSyncButton();
    if (state.handle && (changed || !state.bundle || state.syncError !== errorBefore)) render();
  }
}

function renderSyncButton() {
  const button = document.getElementById("sync");
  button.hidden = !state.key;
  button.disabled = state.syncing;
  button.textContent = state.syncing ? "受信中…" : "受信";
}

/* ---------- 操作 ---------- */
async function setStep(set, step) {
  state.step[set.id] = step;
  await kvSet("step", state.step);
  render();
  scrollTo(0, 0);
}
async function markDone(set) {
  state.done[set.id] = new Date().toISOString();
  delete state.step[set.id];
  await kvSet("done", state.done);
  await kvSet("step", state.step);
  toast("完了しました");
  render();
  scrollTo(0, 0);
}
async function undoDone(set) {
  if (!confirm("このセットを「まだ」に戻しますか？\n\n戻すと、もう一度投稿の手順が始まります。")) return;
  delete state.done[set.id];
  await kvSet("done", state.done);
  render();
}
async function copyReply(set) {
  const text = `${set.reply}\n${set.link}`;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = el("textarea", { value: text });
    document.body.append(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
function saveImage(set, number) {
  const a = el("a", { href: imageUrl(set), download: `x-set${number}-${set.image.name}` });
  document.body.append(a);
  a.click();
  a.remove();
}

/* ---------- 画面 ---------- */
function stepBar(step) {
  const names = ["1 本ポスト", "2 リプライ準備", "3 リプライ"];
  return el("div", { class: "steps" }, ...names.map((name, i) =>
    el("span", { class: i + 1 === step ? "on" : i + 1 < step ? "ok" : "" }, (i + 1 < step ? "✓ " : "") + name)));
}

function viewStep1(set, number, total) {
  const url = "https://x.com/intent/post?text=" + encodeURIComponent(set.main);
  return el("section", { class: "card" },
    stepBar(1),
    el("h2", {}, `セット ${number} / ${total}：本ポスト`),
    el("div", { class: "quote" }, set.main),
    el("a", { class: "btn", href: url, target: "_blank", rel: "noopener", id: "open-main" }, "X で本ポストを開く"),
    el("p", { class: "sub" }, "X が開いたら文章を確認して「ポスト」を押し、このアプリに戻ってください。"),
    el("button", {
      class: "second", id: "main-posted",
      onclick: () => setStep(set, 2),
    }, "ポストした → 次へ"));
}

function viewStep2(set, number, total) {
  return el("section", { class: "card" },
    stepBar(2),
    el("h2", {}, `セット ${number} / ${total}：リプライの準備`),
    el("img", { class: "preview", src: imageUrl(set), alt: "リプライに付ける画像" }),
    el("div", { class: "quote" }, `${set.reply}\n${set.link}`),
    el("button", {
      id: "prepare",
      onclick: async () => {
        // コピーは「押した直後」でないと許可されないので、先に行う
        const copied = await copyReply(set);
        if (!copied) {
          toast("コピーできませんでした。もう一度押してください");
          return;
        }
        saveImage(set, number);
        toast("文章とリンクをコピーし、画像を保存しました");
        await setStep(set, 3);
      },
    }, "画像を保存して、文章をコピー"),
    el("button", { class: "second", onclick: () => setStep(set, 1) }, "← 本ポストに戻る"));
}

function viewStep3(set, number, total) {
  return el("section", { class: "card" },
    stepBar(3),
    el("h2", {}, `セット ${number} / ${total}：リプライ`),
    el("a", { class: "btn", href: `https://x.com/${state.handle}`, target: "_blank", rel: "noopener", id: "open-profile" }, "X で自分のページを開く"),
    el("ol", {},
      el("li", {}, "次の本ポストを開く", el("div", { class: "quote" }, set.main)),
      el("li", {}, "「返信」を押し、入力欄を長押しして「貼り付け」"),
      el("li", {}, "写真のマークを押し、次の画像を選ぶ"),
    ),
    el("img", { class: "preview", src: imageUrl(set), alt: "選ぶ画像" }),
    el("div", { class: "notice" }, "返信先が上の本ポストになっているか確かめてから、「返信」を押してください。"),
    el("button", { class: "second", onclick: async () => {
      toast(await copyReply(set) ? "文章とリンクをコピーしました" : "コピーできませんでした");
    } }, "文章をもう一度コピー"),
    el("button", { class: "second", onclick: () => { saveImage(set, number); toast("画像をもう一度保存しました"); } }, "画像をもう一度保存"),
    el("button", { id: "finish", onclick: () => markDone(set) }, "返信した → 完了"),
    el("button", { class: "second", onclick: () => setStep(set, 2) }, "← 準備に戻る"));
}

function viewList(sets) {
  return el("section", { class: "card" },
    el("h2", {}, "セットの一覧"),
    ...sets.map((set, i) => {
      const done = Boolean(state.done[set.id]);
      return el("div", { class: "row" },
        el("span", { class: "t" }, `${i + 1}. ${set.main}`),
        done
          ? el("button", { class: "small second", onclick: () => undoDone(set) }, "済 ✓")
          : el("span", { class: "tag" }, "まだ"));
    }));
}

function viewHandle() {
  const input = el("input", { id: "handle", placeholder: "例: my_account", autocapitalize: "off", autocomplete: "off", spellcheck: false });
  const message = el("p", { class: "error" });
  return el("section", { class: "card" },
    el("h2", {}, "X の ID を教えてください"),
    el("p", { class: "sub" }, "リプライのときに自分のページを開くために使います。最初の 1 回だけです。"),
    input, message,
    el("button", {
      id: "save-handle",
      onclick: async () => {
        const handle = input.value.trim().replace(/^@/, "");
        if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) {
          message.textContent = "英数字と _ だけ、15 文字以内で入力してください。";
          return;
        }
        state.handle = handle;
        await kvSet("handle", handle);
        render();
      },
    }, "保存"));
}

function render() {
  const view = document.getElementById("view");
  const status = document.getElementById("status");
  view.replaceChildren();
  renderSyncButton();

  if (!state.key) {
    status.textContent = "";
    view.append(el("section", { class: "card" },
      el("h2", {}, "PC と接続してください"),
      el("ol", {},
        el("li", {}, "PC の X_Twitter フォルダで「スマホと接続」をダブルクリック"),
        el("li", {}, "表示された QR コードを、このスマホのカメラで読み取る"))));
    return;
  }
  if (!state.handle) {
    if (state.justConnected) view.append(el("div", { class: "notice" }, "接続しました。"));
    view.append(viewHandle());
    return;
  }

  const sets = state.bundle?.sets ?? [];
  const finished = sets.filter((s) => state.done[s.id]).length;
  status.textContent = state.bundle
    ? `${finished} / ${sets.length} セット完了 ・ PC で作成 ${state.bundle.created.replace("T", " ").slice(0, 16)}`
    : "";
  if (state.syncError) view.append(el("div", { class: "notice" }, state.syncError));

  if (!state.bundle) {
    view.append(el("section", { class: "card" },
      el("h2", {}, state.syncing ? "受信しています…" : "データを待っています"),
      el("p", { class: "sub" }, "PC で投稿データを用意して「スマホへ送る」をダブルクリックし、右上の「受信」を押してください。")));
    return;
  }

  const index = sets.findIndex((s) => !state.done[s.id]);
  if (index === -1) {
    view.append(el("section", { class: "card" },
      el("h2", {}, "全部終わりました 🎉"),
      el("p", { class: "sub" }, "次の投稿は、PC で用意して「スマホへ送る」を押すと届きます。")));
  } else {
    const set = sets[index];
    const step = state.step[set.id] || 1;
    const screens = { 1: viewStep1, 2: viewStep2, 3: viewStep3 };
    view.append(screens[step](set, index + 1, sets.length));
  }
  view.append(viewList(sets));
}

/* ---------- 起動 ---------- */
async function readKeyFromLink() {
  const match = location.hash.match(/k=([A-Za-z0-9_-]{43})/);
  if (!match) return;
  state.key = match[1];
  state.justConnected = true;
  state.etag = "";
  await kvSet("key", state.key);
  await kvSet("etag", "");
  // 鍵を履歴やアドレス欄に残さない
  history.replaceState(null, "", location.pathname);
}

async function init() {
  await loadState();
  await readKeyFromLink();
  window.addEventListener("hashchange", async () => {
    await readKeyFromLink();
    render();
    sync(false);
  });
  document.getElementById("sync").addEventListener("click", () => sync(true));
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") sync(false);
  });
  render();
  sync(false);
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
}
init();

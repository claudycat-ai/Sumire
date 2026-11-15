import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { installContextmenuGuard } from "@/lib/globalContextmenu";

// JSDOM 上で `window` に `contextmenu` イベントを dispatch し、target に応じて
// `preventDefault` が呼ばれるか / 呼ばれないかを観察する。
//
// 抑止される: 通常の <div>, <button> 等
// 抑止されない: <input>, <textarea>, [contenteditable="true"] 配下の要素
//   (= ブラウザ標準のコピペメニュー / スペルチェック / CodeMirror が維持される)

let dispose: (() => void) | null = null;

function dispatchContextmenu(target: Element): Event {
  const event = new Event("contextmenu", { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  dispose = installContextmenuGuard();
});

afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.innerHTML = "";
});

describe("installContextmenuGuard — 抑止される要素", () => {
  it("通常の <div> 上で contextmenu すると preventDefault が呼ばれる", () => {
    const div = document.createElement("div");
    document.body.appendChild(div);

    const event = dispatchContextmenu(div);
    expect(event.defaultPrevented).toBe(true);
  });

  it("通常の <button> 上で contextmenu すると preventDefault が呼ばれる", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);

    const event = dispatchContextmenu(button);
    expect(event.defaultPrevented).toBe(true);
  });
});

describe("installContextmenuGuard — 抑止されない要素", () => {
  it("<input> 上で contextmenu しても preventDefault は呼ばれない", () => {
    const input = document.createElement("input");
    input.type = "text";
    document.body.appendChild(input);

    const event = dispatchContextmenu(input);
    expect(event.defaultPrevented).toBe(false);
  });

  it("<textarea> 上で contextmenu しても preventDefault は呼ばれない", () => {
    const textarea = document.createElement("textarea");
    document.body.appendChild(textarea);

    const event = dispatchContextmenu(textarea);
    expect(event.defaultPrevented).toBe(false);
  });

  it("[contenteditable=\"true\"] 配下の要素では preventDefault は呼ばれない", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editor.appendChild(inner);
    document.body.appendChild(editor);

    // 子要素を target にしても closest('[contenteditable="true"]') で除外されるはず
    const event = dispatchContextmenu(inner);
    expect(event.defaultPrevented).toBe(false);
  });

  it("[contenteditable=\"true\"] 要素そのものを target にしても preventDefault は呼ばれない", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    document.body.appendChild(editor);

    const event = dispatchContextmenu(editor);
    expect(event.defaultPrevented).toBe(false);
  });
});

describe("installContextmenuGuard — disposer", () => {
  it("disposer を呼ぶと以後 contextmenu が抑止されない", () => {
    // beforeEach で installed 済み。一旦解除して未登録の状態にする
    dispose?.();
    dispose = null;

    const div = document.createElement("div");
    document.body.appendChild(div);

    const event = dispatchContextmenu(div);
    expect(event.defaultPrevented).toBe(false);
  });
});

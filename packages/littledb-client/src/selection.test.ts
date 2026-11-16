// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { selectionIn, textSelection } from "./selection.js";

afterEach(() => {
  document.getSelection()?.removeAllRanges();
  document.body.replaceChildren();
});

function reply(html: string): Element {
  const container = document.createElement("article");
  container.innerHTML = html;
  document.body.append(container);
  return container;
}

describe("selectionIn", () => {
  it("reads nested inline elements, Chinese and emoji with UTF-16 offsets", () => {
    const container = reply("開始 <strong>你好<span>🙂世界</span></strong> 結束");
    const range = document.createRange();
    range.setStart(container.querySelector("strong")!.firstChild!, 0);
    range.setEnd(container.querySelector("span")!.firstChild!, 3);
    expect(selectionIn(container, range)).toEqual({ quote: "你好🙂世", start: 3, end: 8, prefix: "開始 ", suffix: "界 結束" });
  });

  it("trims padding and moves the offsets, including element boundaries", () => {
    const container = reply("  <b>  你好🙂  </b>  ");
    const range = document.createRange();
    range.selectNodeContents(container);
    expect(selectionIn(container, range)).toEqual({ quote: "你好🙂", start: 4, end: 8, prefix: "    ", suffix: "    " });
    range.setStart(container, 1);
    range.setEnd(container, 2);
    expect(selectionIn(container, range)?.quote).toBe("你好🙂");
    expect(selectionIn(container, range)?.start).toBe(4);
  });

  it("skips ignored elements and their descendants in both quote and offsets", () => {
    const container = reply('前<span data-feedback-ignore><i>ignore</i></span><b>你好</b><em data-feedback-ignore>also ignored</em>後');
    const range = document.createRange();
    range.selectNodeContents(container.querySelector("b")!);
    expect(selectionIn(container, range)).toEqual({ quote: "你好", start: 1, end: 3, prefix: "前", suffix: "後" });
    range.selectNodeContents(container);
    expect(selectionIn(container, range)?.quote).toBe("前你好後");
    range.selectNodeContents(container.querySelector("i")!);
    expect(selectionIn(container, range)).toBeNull();
    container.setAttribute("data-feedback-ignore", "");
    range.selectNodeContents(container);
    expect(selectionIn(container, range)).toBeNull();
  });

  it("uses the current document selection by default", () => {
    const container = reply("before passage after");
    expect(selectionIn(container)).toBeNull();
    const range = document.createRange();
    range.setStart(container.firstChild!, 7);
    range.setEnd(container.firstChild!, 14);
    document.getSelection()!.addRange(range);
    expect(selectionIn(container)).toEqual(textSelection("before passage after", 7, 14));
  });

  it("returns null for an oversized quote but accepts 2000 units after trimming", () => {
    const container = reply("x".repeat(2500));
    const range = document.createRange();
    range.selectNodeContents(container);
    expect(selectionIn(container, range)).toBeNull();
    range.setEnd(container.firstChild!, 2001);
    expect(selectionIn(container, range)).toBeNull();
    container.textContent = `  ${"x".repeat(2000)}  `;
    range.selectNodeContents(container);
    expect(selectionIn(container, range)).toMatchObject({ quote: "x".repeat(2000), start: 2, end: 2002 });
  });

  it("rejects collapsed, blank and ranges with either endpoint outside", () => {
    const before = reply("before");
    const container = reply("  passage  ");
    const after = reply("after");
    const range = document.createRange();
    range.setStart(container.firstChild!, 2);
    range.collapse(true);
    expect(selectionIn(container, range)).toBeNull();
    range.setStart(container.firstChild!, 0);
    range.setEnd(container.firstChild!, 2);
    expect(selectionIn(container, range)).toBeNull();
    range.setStart(before.firstChild!, 0);
    range.setEnd(container.firstChild!, 9);
    expect(selectionIn(container, range)).toBeNull();
    range.setStart(container.firstChild!, 2);
    range.setEnd(after.firstChild!, 2);
    expect(selectionIn(container, range)).toBeNull();
  });
});

describe("textSelection", () => {
  it("trims and keeps up to 32 UTF-16 units of context on either side", () => {
    const text = `${"p".repeat(40)}  你好🙂  ${"s".repeat(40)}`;
    expect(textSelection(text, 40, 48)).toEqual({ quote: "你好🙂", start: 42, end: 46, prefix: `${"p".repeat(30)}  `, suffix: `  ${"s".repeat(30)}` });
  });

  it("keeps complete emoji at both context-window edges without moving the quote", () => {
    const text = `${"😀".repeat(20)}abc${"😀".repeat(20)}`;
    expect(textSelection(text, 41, 42)).toEqual({
      quote: "b", start: 41, end: 42,
      prefix: `${"😀".repeat(15)}a`, suffix: `c${"😀".repeat(15)}`,
    });
    expect(textSelection(text, 41, 43).prefix).toBe(`${"😀".repeat(15)}a`);
    expect(textSelection(text, 40, 43)).toEqual({
      quote: "abc", start: 40, end: 43, prefix: "😀".repeat(16), suffix: "😀".repeat(16),
    });
  });

  it.each([[-1, 2], [0, 5], [2, 1], [1, 1], [0.5, 2], [0, Number.NaN]])("refuses invalid indexes %s..%s", (start, end) => {
    expect(() => textSelection("text", start, end)).toThrow(RangeError);
  });

  it("refuses blank or oversized passages", () => {
    expect(() => textSelection("   ", 0, 3)).toThrow(RangeError);
    expect(() => textSelection("x".repeat(2001), 0, 2001)).toThrow(RangeError);
  });
});

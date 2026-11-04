import { describe, expect, it } from "vitest";
import {
  automatedEmailReason,
  dmarcResult,
  parseEmailAddress,
  readInboundEmail,
  senderAllowed,
  stripQuotedReply,
  type InboundEmail,
} from "./email-message.js";
import { createTestMessage } from "./testing.js";

function email(overrides: Partial<InboundEmail> = {}): InboundEmail {
  return {
    id: "re_1",
    from: "alice@example.com",
    to: ["support@agents.example.com"],
    cc: [],
    subject: "Refund",
    text: "Hello",
    headers: {},
    headerValues: {},
    attachments: [],
    ...overrides,
  };
}

describe("readInboundEmail", () => {
  it("normalizes a Resend adapter message", () => {
    const message = createTestMessage({
      id: "re_42",
      text: "Where is my order?",
      author: { userId: "alice@example.com", userName: "alice@example.com", isMe: false },
      raw: {
        id: "re_42",
        messageId: "<abc@mail.example.com>",
        from: "Alice Smith <Alice@Example.com>",
        to: ["Support <support@agents.example.com>"],
        cc: ["bob@example.com"],
        subject: "Order 1234",
        text: "Where is my order?",
        html: "<p>Where is my order?</p>",
        headers: { "Auto-Submitted": "no", "In-Reply-To": "<root@x>" },
        attachments: [{ filename: "receipt.pdf", contentType: "application/pdf" }],
      },
    });

    expect(readInboundEmail(message)).toEqual({
      id: "re_42",
      messageId: "<abc@mail.example.com>",
      from: "alice@example.com",
      fromName: "Alice Smith",
      to: ["support@agents.example.com"],
      cc: ["bob@example.com"],
      subject: "Order 1234",
      text: "Where is my order?",
      html: "<p>Where is my order?</p>",
      headers: { "auto-submitted": "no", "in-reply-to": "<root@x>" },
      headerValues: { "auto-submitted": ["no"], "in-reply-to": ["<root@x>"] },
      attachments: [{ name: "receipt.pdf", mimeType: "application/pdf" }],
    });
  });

  it("falls back to the author and message text when raw carries nothing", () => {
    const message = createTestMessage({
      id: "m1",
      text: "hi",
      author: { userId: "Carol@Example.com", userName: "carol", isMe: false },
    });
    expect(readInboundEmail(message)).toMatchObject({ id: "m1", from: "carol@example.com", to: [], text: "hi" });
  });

  it("keeps repeated headers one by one, from name/value pairs or arrays", () => {
    const pairs = readInboundEmail(createTestMessage({
      raw: {
        from: "a@x.com",
        headers: [
          { name: "Authentication-Results", value: "mx.example; dmarc=pass header.from=x.com" },
          { name: "authentication-results", value: "other; dmarc=fail" },
        ],
      },
    }));
    expect(pairs.headerValues["authentication-results"]).toEqual([
      "mx.example; dmarc=pass header.from=x.com",
      "other; dmarc=fail",
    ]);
    expect(pairs.headers["authentication-results"]).toBe("mx.example; dmarc=pass header.from=x.com\nother; dmarc=fail");

    const arrays = readInboundEmail(createTestMessage({
      raw: { from: "a@x.com", headers: { "Authentication-Results": ["mx.example; dmarc=pass", "other; dmarc=fail"] } },
    }));
    expect(arrays.headerValues["authentication-results"]).toEqual(["mx.example; dmarc=pass", "other; dmarc=fail"]);
  });

  it("unfolds folded header values", () => {
    const message = createTestMessage({
      raw: {
        from: "a@x.com",
        headers: { "Authentication-Results": "mx.example;\r\n\tspf=pass smtp.mailfrom=x.com;\n       dmarc=pass header.from=x.com" },
      },
    });
    expect(readInboundEmail(message).headerValues["authentication-results"]).toEqual([
      "mx.example;\tspf=pass smtp.mailfrom=x.com;       dmarc=pass header.from=x.com",
    ]);
  });

  it.each([
    ["Alice <Alice@Example.com>", "alice@example.com"],
    ['"Smith, Alice" <alice@example.com>', "alice@example.com"],
    ["Smith, Alice <alice@example.com>", "alice@example.com"],
    ['"alice@example.com" <alice@example.com>', "alice@example.com"],
    ['"<eve@evil.com>" <ceo@example.com>', "ceo@example.com"],
    ["alice@example.com (Alice)", "alice@example.com"],
  ])("reads the one address in From %s", (fromHeader, from) => {
    expect(readInboundEmail(createTestMessage({ raw: { from: fromHeader } })).from).toBe(from);
  });

  it.each([
    "eve@evil.com, ceo@example.com",
    "Eve <eve@evil.com>, Ceo <ceo@example.com>",
    "eve@evil.com <ceo@example.com>",
    "<eve@evil.com> <ceo@example.com>",
    "undisclosed-recipients:;",
    '"unterminated <ceo@example.com>',
    "not an address",
  ])("leaves from empty when From %s is not exactly one address", (fromHeader) => {
    expect(readInboundEmail(createTestMessage({ raw: { from: fromHeader } })).from).toBe("");
  });
});

describe("parseEmailAddress", () => {
  it("extracts and lower-cases the address", () => {
    expect(parseEmailAddress('"Smith, Alice" <Alice@Example.COM>')).toBe("alice@example.com");
    expect(parseEmailAddress("  Bob@Example.com ")).toBe("bob@example.com");
  });
});

describe("automatedEmailReason", () => {
  it("lets ordinary mail through, including Auto-Submitted: no", () => {
    expect(automatedEmailReason(email())).toBeUndefined();
    expect(automatedEmailReason(email({ headers: { "auto-submitted": "no" } }))).toBeUndefined();
  });

  it.each([
    [{ "auto-submitted": "auto-replied" }, "Auto-Submitted: auto-replied"],
    [{ "auto-submitted": "auto-generated; owner-email=x@y" }, "Auto-Submitted: auto-generated"],
    [{ precedence: "bulk" }, "Precedence: bulk"],
    [{ precedence: "List" }, "Precedence: list"],
    [{ "list-unsubscribe": "<mailto:u@x>" }, "mailing-list header list-unsubscribe"],
    [{ "x-autoreply": "yes" }, "auto-responder header"],
    [{ "return-path": "<>" }, "bounce (null Return-Path)"],
    [{ "content-type": "multipart/report; report-type=delivery-status" }, "delivery status report"],
  ])("refuses %o", (headers, reason) => {
    expect(automatedEmailReason(email({ headers }))).toBe(reason);
  });

  it("refuses mail from a mailer daemon", () => {
    expect(automatedEmailReason(email({ from: "mailer-daemon@mx.example.com" }))).toBe("bounce (mailer-daemon sender)");
  });
});

describe("senderAllowed", () => {
  it("matches addresses and exact domains, ignoring case", () => {
    expect(senderAllowed("Alice@Example.com", ["alice@example.com"])).toBe(true);
    expect(senderAllowed("bob@example.com", ["@Example.com"])).toBe(true);
    expect(senderAllowed("bob@sub.example.com", ["@example.com"])).toBe(false);
    expect(senderAllowed("eve@evil.com", ["@example.com", "alice@example.com"])).toBe(false);
  });
});

describe("dmarcResult", () => {
  const RECEIVER = { authServId: "mx.example" };
  const withResults = (values: string | string[], from = "alice@example.com") => {
    const list = typeof values === "string" ? [values] : values;
    return email({
      from,
      headers: { "authentication-results": list.join("\n") },
      headerValues: { "authentication-results": list },
    });
  };

  it("passes on an aligned dmarc=pass verdict from the receiving server", () => {
    expect(dmarcResult(withResults("mx.example; spf=pass; dkim=pass; dmarc=pass header.from=example.com"), RECEIVER)).toBe(
      "pass",
    );
    expect(dmarcResult(withResults("MX.Example 1; dmarc=pass (p=REJECT) header.from=example.com"), RECEIVER)).toBe("pass");
  });

  it("is none without a verdict", () => {
    expect(dmarcResult(email(), RECEIVER)).toBe("none");
    expect(dmarcResult(withResults("mx.example; spf=pass"), RECEIVER)).toBe("none");
  });

  it("fails on a failing verdict, even next to a planted pass", () => {
    expect(dmarcResult(withResults("mx.example; dmarc=fail (p=reject)"), RECEIVER)).toBe("fail");
    expect(dmarcResult(withResults(["mx.example; dmarc=fail", "mx.example; dmarc=pass"]), RECEIVER)).toBe("fail");
  });

  it("fails when the verdict names another domain", () => {
    expect(dmarcResult(withResults("mx.example; dmarc=pass header.from=evil.com"), RECEIVER)).toBe("fail");
  });

  it("only counts headers from authServId, so a planted header proves nothing", () => {
    const planted = "forged.example; dmarc=pass header.from=example.com";
    expect(dmarcResult(withResults([planted, "mx.example; dmarc=pass header.from=example.com"]), RECEIVER)).toBe("pass");
    expect(dmarcResult(withResults(planted), RECEIVER)).toBe("none");
    expect(dmarcResult(withResults("mx.example.evil.com; dmarc=pass header.from=example.com"), RECEIVER)).toBe("none");
    expect(dmarcResult(withResults("mx.example; dmarc=pass header.from=example.com"), { authServId: " " })).toBe("none");
  });

  it("reads a folded header, one result per continuation line", () => {
    const folded = [
      "mx.example;",
      "       dkim=pass header.i=@example.com header.s=s1;",
      "       spf=pass (mx.example: domain of alice@example.com designates 192.0.2.1 as permitted sender) smtp.mailfrom=alice@example.com;",
      "       dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=example.com",
    ];
    expect(dmarcResult(withResults(folded.join("\r\n")), RECEIVER)).toBe("pass");
    expect(dmarcResult(withResults(folded.join("\n").replace("dmarc=pass", "dmarc=fail")), RECEIVER)).toBe("fail");
  });

  it("is not fooled by a planted one-line pass next to a folded failure", () => {
    const realFailure = "mx.example;\r\n\tspf=fail smtp.mailfrom=evil.com;\r\n\tdmarc=fail (p=NONE) header.from=example.com";
    expect(dmarcResult(withResults([realFailure, "x; dmarc=pass header.from=example.com"]), RECEIVER)).toBe("fail");
    expect(dmarcResult(withResults([realFailure, "mx.example; dmarc=pass header.from=example.com"]), RECEIVER)).toBe("fail");
  });

  it("ignores a pass hidden in a comment or quoted string, but not a failure", () => {
    const hidden = 'mx.example; spf=pass (relay said "; dmarc=pass header.from=example.com") smtp.mailfrom="a;dmarc=pass"@x.com';
    expect(dmarcResult(withResults(hidden), RECEIVER)).toBe("none");
    const swallowed = 'mx.example; spf=fail smtp.mailfrom="x@evil.com; dmarc=fail header.from=example.com';
    expect(dmarcResult(withResults([swallowed, "mx.example; dmarc=pass header.from=example.com"]), RECEIVER)).toBe("fail");
    const commented = "mx.example; spf=fail (x; dmarc=fail) smtp.mailfrom=evil.com";
    expect(dmarcResult(withResults([commented, "mx.example; dmarc=pass header.from=example.com"]), RECEIVER)).toBe("fail");
  });
});

describe("stripQuotedReply", () => {
  it("removes a Gmail attribution and everything after it", () => {
    const text = [
      "Thanks, that worked.",
      "",
      "On Mon, 6 Oct 2026 at 10:00, Support <support@agents.example.com> wrote:",
      "> Try restarting the router.",
      "> ",
    ].join("\n");
    expect(stripQuotedReply(text)).toEqual({
      text: "Thanks, that worked.",
      removed: "On Mon, 6 Oct 2026 at 10:00, Support <support@agents.example.com> wrote:\n> Try restarting the router.\n>",
    });
  });

  it("handles an attribution wrapped over two lines", () => {
    const text = "Yes please.\n\nOn Mon, 6 Oct 2026 at 10:00 AM Support Agent <support@agents.example.com>\nwrote:\n> Shall I refund it?";
    expect(stripQuotedReply(text).text).toBe("Yes please.");
  });

  it("removes an Outlook header block and an Original Message separator", () => {
    const outlook = "See below.\n\n________________________________\nFrom: Support <support@x.com>\nSent: Monday\nTo: Alice\nSubject: Re: Order\n\nOld text";
    expect(stripQuotedReply(outlook).text).toBe("See below.");
    const original = "Fine.\n-----Original Message-----\nFrom: x\nold";
    expect(stripQuotedReply(original).text).toBe("Fine.");
  });

  it("removes a signature and a mobile footer", () => {
    expect(stripQuotedReply("Call me tomorrow.\n-- \nAlice Smith\nAcme Corp").text).toBe("Call me tomorrow.");
    expect(stripQuotedReply("Ok\n\nSent from my iPhone").text).toBe("Ok");
  });

  it("keeps inline replies between quoted lines", () => {
    const text = "> What is the order number?\n1234\n> And the postcode?\nSW1A 1AA";
    expect(stripQuotedReply(text)).toEqual({ text, removed: "" });
  });

  it("leaves forwards alone", () => {
    const forwarded = "Can you handle this?\n\n---------- Forwarded message ---------\nFrom: Bob <bob@x.com>\nDate: Mon\nSubject: Help\n\nMy order is late.";
    expect(stripQuotedReply(forwarded).text).toBe(forwarded);
    const quoted = "FYI\n\nOn Mon, Bob wrote:\n> late order";
    expect(stripQuotedReply(quoted, { subject: "Fwd: late order" }).text).toBe(quoted);
  });

  it("returns the original text when stripping would leave nothing", () => {
    const text = "On Mon, Bob wrote:\n> only quoted";
    expect(stripQuotedReply(text)).toEqual({ text, removed: "" });
  });
});

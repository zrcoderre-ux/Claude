const test = require("node:test");
const assert = require("node:assert");
const M = require("../src/mdexport.js");

function conv(messages, name) {
  return { name: name || "Smith v. Jones — MSJ", chat_messages: messages };
}
function human(text) {
  return { sender: "human", content: [{ type: "text", text: text }] };
}
function claude(blocks) {
  return { sender: "assistant", content: blocks };
}

test("a saved conversation reads as the conversation it was", () => {
  const md = M.conversationMarkdown(
    conv([human("Draft the ruling"), claude([{ type: "text", text: "Here it is." }])]),
    { url: "https://claude.ai/chat/abc", dateStr: "8 Aug 2026, 14:00" }
  );
  assert.match(md, /^# Smith v\. Jones — MSJ/);
  assert.match(md, /\*\*Source:\*\* https:\/\/claude\.ai\/chat\/abc/);
  assert.match(md, /\*\*Saved:\*\* 8 Aug 2026, 14:00/);
  assert.match(md, /\*\*Messages:\*\* 2/);
  assert.match(md, /## You\n\nDraft the ruling/);
  assert.match(md, /## Claude\n\nHere it is\./);
  assert.ok(md.indexOf("## You") < md.indexOf("## Claude"), "in the order they were said");
  assert.ok(md.endsWith("\n"));
});

test("thinking is left out, and the file says so", () => {
  // Scratch work, not the answer — and pasting a chat's worth of it into a
  // fresh context spends that context on reasoning the conclusions superseded.
  const md = M.conversationMarkdown(
    conv([
      claude([
        { type: "thinking", thinking: "SECRET SCRATCH WORK" },
        { type: "text", text: "The ruling." },
      ]),
    ])
  );
  assert.ok(!/SECRET SCRATCH WORK/.test(md), "not in the file");
  assert.match(md, /The ruling\./);
  // A file that claims to be the whole conversation and isn't would be worse
  // than one that says what it left out.
  assert.match(md, /thinking blocks are not included/i);
});

test("an artifact is saved — often it's where the work actually is", () => {
  const md = M.conversationMarkdown(
    conv([
      claude([
        { type: "text", text: "I've drafted it." },
        { type: "tool_use", input: { title: "Tentative Ruling", content: "NATURE OF PROCEEDINGS" } },
      ]),
    ])
  );
  assert.match(md, /I've drafted it\./);
  assert.match(md, /\*\*Tentative Ruling\*\*/);
  assert.match(md, /```\nNATURE OF PROCEEDINGS\n```/);
});

test("a fence outlives what it has to contain", () => {
  // An artifact holding ``` would close the block early, and the rest of the
  // conversation would render as prose inside it.
  const md = M.conversationMarkdown(
    conv([claude([{ type: "tool_use", input: { title: "Notes", content: "a\n```\nb\n```\nc" } }])])
  );
  assert.match(md, /````\na\n```\nb\n```\nc\n````/);
});

test("attachments are named, since their bytes aren't in the payload", () => {
  const md = M.conversationMarkdown(
    conv([
      {
        sender: "human",
        content: [{ type: "text", text: "See attached" }],
        files: [{ file_name: "motion.pdf" }, { name: "opposition.docx" }],
      },
    ])
  );
  assert.match(md, /_Attached: motion\.pdf, opposition\.docx_/);
  assert.match(md, /See attached/);
});

test("who said what survives both spellings the payload uses", () => {
  assert.equal(M.speaker({ sender: "human" }), "You");
  assert.equal(M.speaker({ role: "user" }), "You");
  assert.equal(M.speaker({ sender: "assistant" }), "Claude");
  assert.equal(M.speaker({ role: "assistant" }), "Claude");
  assert.equal(M.speaker({}), "Unknown");
});

test("an empty or unreadable conversation produces a file that says so", () => {
  const md = M.conversationMarkdown(conv([]));
  assert.match(md, /no messages/i);
  assert.match(md, /\*\*Messages:\*\* 0/);
  // Never throws on a payload that isn't the shape we expected.
  assert.match(M.conversationMarkdown(null), /^# Claude conversation/);
  assert.match(M.conversationMarkdown({ chat_messages: "nope" }), /no messages/i);
  assert.deepEqual(M.messagesOf(null), []);
});

test("the filename sorts, and holds nothing a filesystem would refuse", () => {
  assert.equal(
    M.exportFileName(conv([], "Smith v. Jones: MSJ / part 2"), "2026-08-08"),
    "2026-08-08 Smith v. Jones MSJ part 2.md",
    "date first, so a folder of these falls into order on its own"
  );
  assert.equal(M.exportFileName({}, "2026-08-08"), "2026-08-08 Claude conversation.md");
  assert.equal(M.exportFileName(conv([], "Untitled"), ""), "Untitled.md");
  const long = M.exportFileName(conv([], "x".repeat(300)), "2026-08-08");
  assert.ok(long.length < 95, long.length);
});

/**
 * Cowork probe, round two — paste at the claude.ai console, in Cowork.
 *
 * Round one settled most of it. What Cowork looks like, as of this writing:
 *
 *   the composer      div[data-testid="chat-input"], aria-label
 *                     "Write your prompt to Claude" — the same element chat
 *                     uses, so insertPrompt needs no change
 *   file input        input[data-testid="file-upload"] — unchanged
 *   model picker      button[data-testid="model-selector-dropdown"] —
 *                     unchanged, though it now reads "Opus 5 High", and
 *                     parseModelName stops at "Opus 5"
 *   the project menu  a button whose text is "Project" until something is
 *                     chosen and the project's own name after; opens a
 *                     [role="listbox"][aria-label="Search projects"] of
 *                     [role="option"] rows marked with aria-selected
 *   the approval menu button[aria-label="Manually approve"|"Automatically
 *                     approve"|"Skip all approvals"] — the trigger's OWN
 *                     aria-label is the mode in force, which is the cleanest
 *                     read of state anywhere in this app. It opens three
 *                     [role="menuitemradio"] rows marked with aria-checked,
 *                     each labelled with its name followed by its description
 *                     ("Manually approveClaude pauses so you can…"), so a
 *                     prefix match is the only safe one
 *   the address       toggling to Cowork does NOT change it — /new stays /new.
 *                     A sent message pushState's to /cowork/cse_<id>, where the
 *                     id is not a uuid and the path has no /chat/ in it
 *
 * Three things it did not settle, which is what this asks:
 *
 *   1. The send button. Every selector findSend() tries missed. Round one only
 *      looked after the send, with the composer empty, so the control may
 *      simply not exist until there is something to send — hence "type a word
 *      first, THEN report".
 *   2. The Chat/Cowork toggle. It changes no URL and was never caught being
 *      clicked, so we still have nothing to drive it with.
 *   3. Whether the mode is sticky. This is the one that matters most: if a
 *      fresh tab at /new comes up in Cowork because the app remembers, then
 *      every existing scheduled send and workflow step is already at risk of
 *      running in a mode nobody asked for, and the fix is a check rather than
 *      a feature.
 *
 * It also logs the /api/ calls the page makes, because /cowork/cse_<id> is not
 * a uuid and workflow.js reads a conversation's id off the API traffic.
 *
 *   1. Paste this in the Cowork tab. (Chrome needs "allow pasting" typed once.)
 *   2. Type a word into the composer, don't send. Run: __cw2()
 *   3. Send it. Run: __cw2() again.
 *   4. Open a NEW tab at claude.ai/new, paste this there, run __cw2() without
 *      touching anything — that answers the sticky question.
 */
(()=>{const A=[],n=s=>String(s||"").replace(/\s+/g," ").trim();
const d=e=>{if(!e||!e.tagName)return"-";const b=[e.tagName.toLowerCase()];for(const a of["data-testid","aria-label","role","aria-checked","aria-selected","aria-expanded","aria-haspopup","aria-pressed","data-state","disabled","type","placeholder"]){const v=e.getAttribute&&e.getAttribute(a);if(v!=null&&v!=="")b.push(a+"="+JSON.stringify(String(v).slice(0,60)))}b.push("text="+JSON.stringify(n(e.textContent).slice(0,40)));const c=n(e.className&&e.className.baseVal!=null?e.className.baseVal:e.className);if(c)b.push("class="+JSON.stringify(c.slice(0,60)));return b.join(" ")};
const f=window.fetch;window.fetch=function(){try{const x=arguments[0],u=String((x&&x.url)||x||"").replace(location.origin,"");if(/\/api\//.test(u)&&A.length<40&&A.indexOf(u)<0)A.push(u)}catch(e){}return f.apply(this,arguments)};
window.__cw2=()=>{const ed=document.querySelector('div[data-testid="chat-input"]');let box=ed;for(let i=0;i<9&&box&&box.parentElement;i++){box=box.parentElement;if(box.querySelectorAll('button,[role="button"]').length>=4)break}
const o=["=== cowork probe 2 ===","url: "+location.pathname+location.search,"in cowork: "+(document.querySelector('button[aria-label="Manually approve"],button[aria-label="Automatically approve"],button[aria-label="Skip all approvals"]')?"YES":"no"),"composer empty: "+(ed?JSON.stringify(n(ed.textContent).slice(0,30)):"no editor"),"-- every control around the composer --"];
if(box)for(const b of box.querySelectorAll('button,[role="button"],[role="switch"],[role="tab"],[role="radio"],input,label'))o.push("  "+d(b));else o.push("  (composer box not found)");
o.push("-- anything whose only words are chat / cowork --");
for(const e of document.querySelectorAll('button,[role="button"],[role="tab"],[role="switch"],[role="radio"],label,span,div,a')){const t=n(e.textContent),l=n(e.getAttribute("aria-label")||"");if(!/^(chat|cowork|co-work)$/i.test(t)&&!/^(chat|cowork|co-work)$/i.test(l))continue;if([...e.querySelectorAll("*")].some(c=>/^(chat|cowork|co-work)$/i.test(n(c.textContent))))continue;o.push("  "+d(e),"    parent: "+d(e.parentElement))}
o.push("-- api calls seen since this was pasted --");A.forEach(u=>o.push("  "+u));
const t=o.join("\n").slice(0,50000);console.log(t);try{copy(t);console.log("(copied)")}catch(e){}return t};
console.log("ready. 1) type a word in the composer, run __cw2()  2) send it, run __cw2() again")})()

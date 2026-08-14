/**
 * Cowork probe, the short one — for pasting straight from a chat message when
 * the full scripts/cowork-probe.js can't be opened to copy.
 *
 * Chrome refuses a pasted script into the console until you type the words
 *   allow pasting
 * at the prompt and press Enter. That is Chrome's self-XSS guard, not an error.
 *
 * Same idea as the full probe, less of it: it watches rather than snapshots,
 * because the Chat/Cowork toggle, the Project menu and the approval menu all
 * close on the click that would identify them. Paste it, drive Cowork by hand,
 * then run __cw().
 */
(()=>{const S=[],U=[],C=[],K=new Set();const n=s=>String(s||"").replace(/\s+/g," ").trim();
const d=e=>{if(!e||!e.tagName)return"-";const b=[e.tagName.toLowerCase()];for(const a of["data-testid","aria-label","role","aria-checked","aria-selected","aria-expanded","data-state","href","type"]){const v=e.getAttribute&&e.getAttribute(a);if(v)b.push(a+"="+JSON.stringify(String(v).slice(0,60)))}b.push("text="+JSON.stringify(n(e.textContent).slice(0,60)));return b.join(" ")};
const u=w=>{const p=location.pathname+location.search;if(U.length&&U[U.length-1].p===p)return;U.push({p,w})};u("start");
for(const m of["pushState","replaceState"]){const o=history[m];history[m]=function(){const r=o.apply(this,arguments);setTimeout(()=>u(m),0);return r}}
addEventListener("popstate",()=>setTimeout(()=>u("popstate"),0));
const M='[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]';
const rec=(r,w)=>{if(!r||!r.querySelectorAll)return;const it=[...r.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],button,a[href]')];if(!it.length)return;const k=it.map(e=>n(e.textContent).slice(0,30)+(e.getAttribute("data-state")||e.getAttribute("aria-checked")||"")).join("|");if(K.has(k))return;K.add(k);S.push({w,p:location.pathname,c:d(r),i:it.slice(0,30).map(d)})};
new MutationObserver(rs=>{for(const r of rs){for(const x of r.addedNodes||[]){if(!x||x.nodeType!==1)continue;if(x.matches&&x.matches(M))rec(x,"opened");if(x.querySelectorAll)for(const y of [...x.querySelectorAll(M)].slice(0,3))rec(y,"opened")}
if(r.type==="attributes"&&r.target.closest){const m=r.target.closest(M);if(m)rec(m,"re-marked "+r.attributeName)}}}).observe(document.body,{childList:1,subtree:1,attributes:1,attributeFilter:["data-state","aria-checked","aria-selected","aria-expanded"]});
addEventListener("click",e=>{const t=e.target.closest?e.target.closest('button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],[role="tab"],[role="switch"],a[href]'):null;if(!t)return;const i=C.length;C.push({p:location.pathname,d:d(t)});setTimeout(()=>{if(t.isConnected)C[i].after=d(t);u("click "+n(t.textContent).slice(0,30))},700)},true);
window.__cw=()=>{const o=["=== cowork probe ===","-- urls --",...U.map((x,i)=>` [${i}] ${x.p}  <- ${x.w}`),"-- known selectors --"];
for(const[a,s]of[["editor",'div[data-testid="chat-input"]'],["editor alt",'div.ProseMirror[contenteditable="true"],.tiptap[contenteditable="true"]'],["send",'button[aria-label="Send message"],[data-testid="send-button"],button[aria-label="Send"]'],["model",'button[data-testid="model-selector-dropdown"],button[aria-label^="Model:" i]'],["file",'input[data-testid="file-upload"]'],["reply",'[data-testid="assistant-message"],.font-claude-response']]){const q=document.querySelectorAll(s);o.push(` ${q.length?"MATCH":"NONE "} ${a} (${q.length}) ${s}`);if(q[0])o.push("      "+d(q[0]))}
o.push("-- menus --");S.forEach((m,i)=>{o.push(` [${i}] ${m.w} @ ${m.p}`,"   box: "+m.c,...m.i.map(x=>"    · "+x))});
o.push("-- clicks --");C.forEach((c,i)=>{o.push(` [${i}] @${c.p} ${c.d}`);if(c.after&&c.after!==c.d)o.push("     became: "+c.after)});
const t=o.join("\n").slice(0,50000);console.log(t);try{copy(t);console.log("(copied)")}catch(e){}return t};
console.log("watching. drive Cowork, then run: __cw()")})()

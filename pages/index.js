import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const ROLES = {
  VILLAGER:    { id:"VILLAGER",    name:"村人",     team:"village",  emoji:"🏘️" },
  SEER:        { id:"SEER",        name:"占い師",   team:"village",  emoji:"🔮" },
  MEDIUM:      { id:"MEDIUM",      name:"霊媒師",   team:"village",  emoji:"👻" },
  KNIGHT:      { id:"KNIGHT",      name:"騎士",     team:"village",  emoji:"🛡️" },
  ILLUSIONIST: { id:"ILLUSIONIST", name:"幻術師",   team:"village",  emoji:"✨" },
  WEREWOLF:    { id:"WEREWOLF",    name:"人狼",     team:"werewolf", emoji:"🐺" },
  MADMAN:      { id:"MADMAN",      name:"狂人",     team:"werewolf", emoji:"🃏" },
  WITCH:       { id:"WITCH",       name:"魔女",     team:"third",    emoji:"🧙" },
  BAKER:       { id:"BAKER",       name:"パン屋",   team:"village",  emoji:"🍞" },
  TRAITOR:     { id:"TRAITOR",     name:"裏切り者", team:"third",    emoji:"🗡️" },
};

const PHASES = {
  LOBBY:"LOBBY", ROLE_SETUP:"ROLE_SETUP",
  DAY:"DAY", VOTE:"VOTE", EXECUTION:"EXECUTION",
  NIGHT:"NIGHT", GAME_OVER:"GAME_OVER"
};

const AI_NAMES = ["きなこ","ぷち","ココア","つくね","うさぎ","くりまんじゅう","ハチワレ","ちいかわ","鎧さん"];
const DEFAULT_CFG = { VILLAGER:3, WEREWOLF:2, SEER:1, KNIGHT:1, MADMAN:1 };
const DAY_SEC = 240;

const PERSONALITIES = {
  logic:    { name:"論理型",   desc:"発言の矛盾や投票履歴を重視する。冷静で根拠を大切にする。", tone:"冷静に" },
  emotion:  { name:"感情型",   desc:"直感や雰囲気で話す。感情的な訴えが多い。", tone:"感情的に" },
  silent:   { name:"寡黙型",   desc:"短く話すが重要な時だけ発言する。", tone:"短く端的に" },
  assertive:{ name:"強弁型",   desc:"断定的に主張する。自信満々な口調。", tone:"断定的に" },
  suspicious:{ name:"疑り深い型", desc:"複数人を警戒する。常に誰かを疑っている。", tone:"疑わしそうに" },
  natural:  { name:"天然型",   desc:"少しズレた発言もするが完全な意味不明にはしない。", tone:"少しズレた感じで" },
  normal:   { name:"普通型",   desc:"バランスよく発言する。", tone:"自然に" },
};

const rnd = a => a[Math.floor(Math.random() * a.length)];
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// GEMINI API
// ─────────────────────────────────────────────────────────────
async function callGemini(prompt) {
  try {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) return null;
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 150, temperature: 1.0, topP: 0.95 },
          safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
          ],
        }),
      }
    );
    if (!res.ok) return null;
    const data = await res.json();
    let text = data.candidates?.[0]?.content?.parts?.[0]?.text || null;
    if (!text) return null;
    text = text.replace(/^[\s「」『』"'\n]+|[\s「」『』"'\n]+$/g, "").trim();
    // 長すぎる場合は最初の2文に絞る
    const sentences = text.split(/。|！|？/).filter(s => s.trim());
    if (sentences.length > 2) text = sentences.slice(0,2).join("。") + "。";
    if (text.length > 130) text = text.substring(0, 130) + "…";
    return text;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// AI MEMORY - 各AIの個別メモリ
// ─────────────────────────────────────────────────────────────
function createMemory(role, allies = []) {
  return {
    role,
    claimedRole: null,          // COした役職
    seerResults: [],            // 占い結果 [{name, result, day}]
    mediumResults: [],          // 霊媒結果 [{name, result, day}]
    suspects: {},               // {name: 疑い度(0-10)}
    trusted: {},                // {name: 信頼度(0-10)}
    voteHistory: [],            // [{day, target}]
    pastStatements: [],         // 自分の過去発言 [{day, text}]
    questionsReceived: [],      // 受けた質問
    illusionistUsed: false,     // 幻術師の能力使用済み
    wolfAllies: allies,         // 仲間の人狼名
    knownRoles: {},             // 知っている他人の役職 {name: role}
  };
}

// ─────────────────────────────────────────────────────────────
// PROMPT BUILDER - 完全な状況をLLMに渡す
// ─────────────────────────────────────────────────────────────
function buildFullPrompt(ai, memory, allPlayers, chatLog, day, trigger, humanMsg) {
  const alive = allPlayers.filter(p => p.alive);
  const dead = allPlayers.filter(p => !p.alive);
  const isWolf = ["WEREWOLF", "MADMAN"].includes(memory.role);
  const isSeer = memory.role === "SEER";
  const isMedium = memory.role === "MEDIUM";
  const personality = PERSONALITIES[ai.personality] || PERSONALITIES.normal;

  // 直近の会話ログ（最大10件）
  const recentChat = chatLog
    .filter(m => m.type !== "gm")
    .slice(-10)
    .map(m => `  ${m.sender}：${m.text}`)
    .join("\n");

  // 公開されている役職CO情報
  const coClaims = allPlayers
    .filter(p => p.memory?.claimedRole)
    .map(p => `  ${p.name}：${ROLES[p.memory.claimedRole]?.name || p.memory.claimedRole}とCO`)
    .join("\n") || "  なし";

  // 公開されている占い結果
  const publicSeerResults = chatLog
    .filter(m => m.isSeer)
    .slice(-5)
    .map(m => `  ${m.sender}：${m.text}`)
    .join("\n") || "  なし";

  // 自分の過去発言
  const myPastStatements = memory.pastStatements
    .slice(-5)
    .map(s => `  ${s.day}日目：${s.text}`)
    .join("\n") || "  なし";

  // 占い結果（自分が得た）
  const mySeerResults = memory.seerResults
    .map(r => `  ${r.day}日目夜：${r.name}→${r.result}`)
    .join("\n") || "  なし";

  // 霊媒結果（自分が得た）
  const myMediumResults = memory.mediumResults
    .map(r => `  ${r.day}日目：${r.name}（処刑済み）→${r.result}`)
    .join("\n") || "  なし";

  // 投票履歴
  const myVoteHistory = memory.voteHistory
    .map(v => `  ${v.day}日目：${v.target}に投票`)
    .join("\n") || "  なし";

  // 疑っている人
  const mySuspects = Object.entries(memory.suspects)
    .filter(([,v]) => v >= 4)
    .sort((a,b) => b[1]-a[1])
    .map(([name,v]) => `  ${name}（疑い度${v}）`)
    .join("\n") || "  特になし";

  // 信頼している人
  const myTrusted = Object.entries(memory.trusted)
    .filter(([,v]) => v >= 4)
    .sort((a,b) => b[1]-a[1])
    .map(([name,v]) => `  ${name}（信頼度${v}）`)
    .join("\n") || "  特になし";

  // 人狼専用情報
  const wolfInfo = isWolf && memory.wolfAllies.length > 0
    ? `\n【仲間の人狼（絶対秘密）】\n  ${memory.wolfAllies.join("、")}`
    : "";

  // 直前のトリガー
  const triggerInfo = trigger
    ? `\n【直前の発言（これに対して返答することが最優先）】\n  ${trigger.sender}：「${trigger.text}」`
    : "";

  // 人間からの質問への特別指示
  const humanInstruction = humanMsg
    ? buildHumanResponseInstruction(ai, memory, humanMsg, allPlayers, day)
    : "";

  // 役職別の戦略指示
  const roleStrategy = buildRoleStrategy(memory, ai, allPlayers, day);

  return `あなたは人狼ゲームのAIプレイヤー「${ai.name}」です。

━━ 自分の基本情報 ━━
・名前：${ai.name}
・性格：${personality.name}（${personality.desc}）
・本当の役職：${ROLES[memory.role]?.name}（${isWolf ? "人狼陣営" : ROLES[memory.role]?.team === "village" ? "村人陣営" : "第三勢力"}）
・自分がCOした役職：${memory.claimedRole ? ROLES[memory.claimedRole]?.name : "まだCOしていない"}${wolfInfo}

━━ ゲーム状況 ━━
・現在：${day}日目の昼
・生存者：${alive.map(p=>p.name).join("、")}
・死亡者：${dead.length > 0 ? dead.map(p=>p.name).join("、") : "なし"}

━━ 公開情報 ━━
役職CO状況：
${coClaims}

公開された占い結果：
${publicSeerResults}

━━ 自分だけが知っている情報 ━━
自分の占い結果：
${mySeerResults}

自分の霊媒結果：
${myMediumResults}

疑っている人：
${mySuspects}

信頼している人：
${myTrusted}

━━ 自分の行動履歴 ━━
過去発言：
${myPastStatements}

投票履歴：
${myVoteHistory}

━━ 直近の会話 ━━
${recentChat || "（まだ発言なし）"}
${triggerInfo}

━━ 役職別戦略 ━━
${roleStrategy}
${humanInstruction}

━━ 絶対ルール ━━
1. 過去の自分の発言と矛盾しないこと
2. 占い結果は実際に得た結果のみ使うこと（でたらめを言わない）
3. 直前の発言・質問には必ず反応すること（無視禁止）
4. 「〇〇さんへの疑いが強まっています」のような抽象的な発言は禁止。具体的な根拠を述べること
5. 実際に起きていないことを「昨日〜した」と言わない
6. 1〜3文の自然な日本語のみ
7. ${personality.tone}話すこと
8. 同じ表現を繰り返さないこと

今の状況を踏まえた発言（1〜3文）：`;
}

// 役職別の戦略指示を生成
function buildRoleStrategy(memory, ai, allPlayers, day) {
  const isWolf = ["WEREWOLF", "MADMAN"].includes(memory.role);
  const isSeer = memory.role === "SEER";
  const isMedium = memory.role === "MEDIUM";

  if (memory.role === "WEREWOLF") {
    const wolfNames = memory.wolfAllies.join("、") || "なし";
    return `あなたは人狼です。村人のふりをして村人陣営を処刑に誘導するのが目標。
・仲間（${wolfNames}）を守る。彼らへの疑いを他に向ける
・占い師を名乗って偽情報を流す戦術も有効（特に本物の占い師が死んだ後は使いやすいが、タイミングは慎重に）
・質問されたら村人として自然に嘘をつく
・具体的な根拠を挙げて村人陣営を疑わせる`;
  }

  if (memory.role === "MADMAN") {
    return `あなたは狂人です。人狼陣営を勝たせるために村人陣営を混乱させるのが目標。
・偽の役職COをして情報を撹乱させることも有効
・でたらめな疑いをかけて場を乱す
・人狼が誰かは分からないが、村人陣営の議論を妨害する`;
  }

  if (isSeer) {
    const hasResults = memory.seerResults.length > 0;
    return `あなたは占い師です。
・得た占い結果：${hasResults ? memory.seerResults.map(r=>`${r.name}→${r.result}`).join("、") : "まだなし"}
・${hasResults ? "結果を持っているなら積極的にCOを検討する（早すぎると人狼に狙われるリスクあり）" : "まだ結果がないなら潜伏を続ける"}
・偽占い師が現れたら「私が本物です」と主張する
・質問されたらCOするか潜伏するか状況を見て判断する`;
  }

  if (isMedium) {
    const hasResults = memory.mediumResults.length > 0;
    return `あなたは霊媒師です。処刑された人の役職を確認できます。
・確認できた結果：${hasResults ? memory.mediumResults.map(r=>`${r.name}→${r.result}`).join("、") : "まだなし"}
・結果を持っているなら状況に応じてCOを検討する
・偽霊媒師が出たら反論する`;
  }

  if (memory.role === "KNIGHT") {
    return `あなたは騎士です。夜に誰かを人狼の攻撃から守れます。
・役職は隠しながら議論に参加する
・有用と判断したらCOして守ることを宣言するのも一つの手`;
  }

  return `あなたは${ROLES[memory.role]?.name}（村人陣営）です。
・人狼を見つけることが目標
・具体的な根拠を持って疑いを述べる
・他のプレイヤーの発言をよく聞いて矛盾を指摘する`;
}

// 人間の発言に対する特別な応答指示
function buildHumanResponseInstruction(ai, memory, humanMsg, allPlayers, day) {
  const text = humanMsg.text;
  const sender = humanMsg.sender;
  const isWolf = ["WEREWOLF", "MADMAN"].includes(memory.role);
  const isSeer = memory.role === "SEER";
  const isMedium = memory.role === "MEDIUM";

  // 役職確認・CO要求
  if (/役職|正体|何者|COして|カミングアウト|占い師い|霊媒師い|騎士い|村人い/.test(text)) {
    if (isSeer) {
      const hasResults = memory.seerResults.length > 0;
      return `\n【重要指示】${sender}が役職について聞いています。
あなたは占い師です。COするかどうか判断してください。
COする場合：「占い師です。${hasResults ? memory.seerResults[memory.seerResults.length-1].name + "は" + memory.seerResults[memory.seerResults.length-1].result + "でした" : "まだ結果がありません"}」と答える。
潜伏する場合：「村人として頑張っています」など曖昧に答える。
必ず返答すること。無視禁止。`;
    }
    if (isMedium) {
      return `\n【重要指示】${sender}が役職について聞いています。
あなたは霊媒師です。COするかどうか状況を見て判断して返答してください。必ず返答すること。`;
    }
    if (isWolf) {
      return `\n【重要指示】${sender}が役職について聞いています。
あなたは人狼ですが村人のふりをしてください。「村人です」と答えるか、状況によって偽COするか判断してください。必ず返答すること。`;
    }
    return `\n【重要指示】${sender}が役職について聞いています。
あなたは${ROLES[memory.role]?.name}です。正直に答えるか潜伏するか判断して返答してください。必ず返答すること。`;
  }

  // 占い結果の要求
  if (/占い結果|占って|誰を占|占いの結果/.test(text)) {
    if (isSeer && memory.seerResults.length > 0) {
      const latest = memory.seerResults[memory.seerResults.length-1];
      return `\n【重要指示】占い結果を求められています。
あなたは占い師で、${latest.name}を占い「${latest.result}」という結果を得ています。
COして結果を公開するか、潜伏を続けるか判断して返答してください。`;
    }
  }

  // 疑われた・名指しされた
  if (text.includes(ai.name) && /怪し|疑|投票|処刑|人狼じゃ|嘘/.test(text)) {
    return `\n【重要指示】${sender}があなた（${ai.name}）を直接疑っています。
必ず弁明や反論をしてください。${isWolf ? "人狼である事実は隠しつつ、具体的な反論で疑いをかわしてください。" : "正直に弁明してください。"}`;
  }

  // 直接の質問
  if (text.includes(ai.name) && /[？?]|どう思|どうして|なぜ|なんで|教えて/.test(text)) {
    return `\n【重要指示】${sender}があなた（${ai.name}）に直接質問しています。
必ずこの質問に答えてください。完全な無視は絶対禁止です。`;
  }

  // 全員への質問
  if (/[？?]|どう思|誰が|みんな|全員/.test(text)) {
    return `\n【重要指示】${sender}が全員に質問または呼びかけています。
あなたもこれに反応して発言してください。`;
  }

  return "";
}

// ─────────────────────────────────────────────────────────────
// PLAYER FACTORY
// ─────────────────────────────────────────────────────────────
function buildPlayers(humanName, cfg) {
  const roles = [];
  Object.entries(cfg).forEach(([r,c]) => { for(let i=0;i<c;i++) roles.push(r); });
  const shuffled = [...roles].sort(() => Math.random() - 0.5);
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
  const personalityKeys = Object.keys(PERSONALITIES);

  // 人狼同士を把握させる
  const wolfPositions = [];
  shuffled.forEach((r, i) => { if (r === "WEREWOLF") wolfPositions.push(i); });

  const players = [{
    id:"human", name:humanName.trim()||"あなた", isHuman:true,
    role:shuffled[0], alive:true, personality:"normal",
    memory: createMemory(shuffled[0]),
  }];

  for (let i=1; i<shuffled.length; i++) {
    const role = shuffled[i];
    const wolfAllies = role === "WEREWOLF"
      ? wolfPositions.filter(pos => pos !== i).map(pos =>
          pos === 0 ? (humanName.trim()||"あなた") : names[(pos-1) % names.length]
        )
      : [];
    players.push({
      id:`ai_${i}`, name:names[(i-1)%names.length], isHuman:false,
      role, alive:true,
      personality: personalityKeys[(i-1) % personalityKeys.length],
      memory: createMemory(role, wolfAllies),
    });
  }

  return players;
}

function checkWin(players) {
  const al=players.filter(p=>p.alive);
  const aw=al.filter(p=>p.role==="WEREWOLF");
  const av=al.filter(p=>!["WEREWOLF","WITCH","TRAITOR"].includes(p.role));
  const witch=al.find(p=>p.role==="WITCH");
  const traitor=al.find(p=>p.role==="TRAITOR");
  if(!aw.length){const w=["村人陣営"];if(witch)w.push("魔女");if(traitor)w.push("裏切り者");return{over:true,winners:w};}
  if(aw.length>=av.length){const w=["人狼陣営"];if(witch)w.push("魔女");if(traitor)w.push("裏切り者");return{over:true,winners:w};}
  return{over:false,winners:[]};
}

function computeExecution(aiVotes, humanVote) {
  const tally={};
  Object.values(aiVotes).forEach(id=>{tally[id]=(tally[id]||0)+1;});
  if(humanVote)tally[humanVote]=(tally[humanVote]||0)+1;
  const mx=Math.max(...Object.values(tally));
  const tied=Object.entries(tally).filter(([,v])=>v===mx).map(([id])=>id);
  return{winnerId:tied[Math.floor(Math.random()*tied.length)],tally};
}

function decideVote(ai, allPlayers) {
  const cands = allPlayers.filter(p => p.alive && p.id !== ai.id);
  if (!cands.length) return null;
  const isWolf = ["WEREWOLF","MADMAN"].includes(ai.role);
  if (isWolf) {
    const wolfIds = allPlayers.filter(p=>["WEREWOLF","MADMAN"].includes(p.role)).map(p=>p.id);
    const targets = cands.filter(p=>!wolfIds.includes(p.id));
    return (targets.length?targets:cands)[Math.floor(Math.random()*(targets.length||cands.length))].id;
  }
  // 占い師がクロ判定した人
  const knownWolf = cands.find(p => ai.memory?.seerResults?.some(r => r.name===p.name && r.result==="人狼"));
  if (knownWolf) return knownWolf.id;
  // 疑い度が高い人
  const sus = ai.memory?.suspects || {};
  const sorted = [...cands].sort((a,b)=>(sus[b.name]||3)-(sus[a.name]||3));
  return sorted[0]?.id || cands[Math.floor(Math.random()*cands.length)].id;
}

// ─────────────────────────────────────────────────────────────
// STYLES
// ─────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700;900&family=Zen+Antique&display=swap');
:root{--bg:#0a0a0f;--surf:#12121a;--surf2:#1a1a26;--bdr:#2a2a3a;--gold:#c8a96e;--red:#cc3333;--blue:#4477dd;--green:#33aa66;--purple:#7744cc;--text:#e8e0d0;--muted:#9090a0;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:'Noto Serif JP',serif;}
.app{display:flex;flex-direction:column;height:100vh;max-width:820px;margin:0 auto}
.scroll{overflow-y:auto;flex:1;padding:14px}
.scroll::-webkit-scrollbar{width:3px}
.scroll::-webkit-scrollbar-thumb{background:var(--bdr)}
.day-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:0 12px 12px}
.day-top{flex-shrink:0;padding-bottom:6px}
.chat-main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--surf);border:1px solid var(--bdr);border-radius:11px;min-height:0}
.chat-hdr{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bdr);flex-shrink:0}
.chat-body{flex:1;overflow-y:auto;padding:10px;min-height:0;scroll-behavior:smooth;}
.chat-body::-webkit-scrollbar{width:3px}
.chat-body::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px}
.chat-foot{flex-shrink:0;padding:8px;border-top:1px solid var(--bdr);display:flex;gap:7px;background:var(--surf)}
.chat-foot input{flex:1;background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;color:var(--text);font-family:'Noto Serif JP',serif;padding:10px 12px;font-size:.84rem;outline:none}
.chat-foot input:focus{border-color:var(--gold)}
.send-btn{background:var(--gold);color:#1a1000;border:none;border-radius:8px;padding:10px 16px;font-family:'Noto Serif JP',serif;font-size:.84rem;font-weight:700;cursor:pointer;flex-shrink:0}
.send-btn:disabled{opacity:.4;cursor:not-allowed}
.vote-area{flex-shrink:0;padding-top:7px}
.hdr{text-align:center;padding:12px 12px 8px;border-bottom:1px solid var(--bdr);flex-shrink:0}
.hdr h1{font-family:'Zen Antique',serif;font-size:1.7rem;color:var(--gold);text-shadow:0 0 18px rgba(200,169,110,.35);letter-spacing:.1em}
.hdr .sub{color:var(--muted);font-size:.69rem;margin-top:2px;letter-spacing:.14em}
.pill{display:inline-block;padding:3px 12px;border-radius:12px;font-size:.69rem;font-weight:700;letter-spacing:.08em;margin-top:5px}
.p-day{background:rgba(200,169,110,.13);color:var(--gold);border:1px solid var(--gold)}
.p-night{background:rgba(40,0,90,.5);color:#bb99ff;border:1px solid var(--purple)}
.p-vote{background:rgba(160,0,0,.2);color:#ff7777;border:1px solid var(--red)}
.p-exec{background:rgba(100,0,0,.4);color:#ffaaaa;border:1px solid var(--red)}
.tbar{background:var(--surf2);border:1px solid var(--bdr);border-radius:7px;padding:6px 10px;margin-bottom:6px}
.tbar-row{display:flex;justify-content:space-between;font-size:.69rem;margin-bottom:3px}
.tl{color:var(--gold);font-weight:700}.tr{color:var(--muted)}
.ttrack{height:4px;background:var(--bdr);border-radius:2px;overflow:hidden}
.tfill{height:100%;border-radius:2px;transition:width .95s linear,background .4s}
.myrole{background:linear-gradient(135deg,var(--surf),rgba(200,169,110,.07));border:1px solid var(--gold);border-radius:9px;padding:8px 12px;margin-bottom:6px;display:flex;align-items:center;gap:10px}
.mre{font-size:1.65rem;flex-shrink:0}.mrn{font-size:.88rem;font-weight:700;color:var(--gold)}.mrd{font-size:.64rem;color:var(--muted);margin-top:1px}.mri{font-size:.64rem;color:var(--gold);margin-top:1px}
.wolf-info{background:rgba(100,0,0,.2);border:1px solid var(--red);border-radius:8px;padding:7px 11px;margin-bottom:6px;font-size:.72rem;color:#ff9999}
.card{background:var(--surf);border:1px solid var(--bdr);border-radius:11px;padding:13px;margin-bottom:10px}
.ct{font-size:.8rem;color:var(--gold);letter-spacing:.08em;margin-bottom:7px;padding-bottom:6px;border-bottom:1px solid var(--bdr)}
.btn{padding:9px 18px;border-radius:8px;border:none;cursor:pointer;font-family:'Noto Serif JP',serif;font-size:.8rem;font-weight:700;transition:all .14s}
.bp{background:var(--gold);color:#1a1000}.bp:hover{background:#e0bf70}
.bd{background:var(--red);color:#fff}.bd:hover{background:#ee4444}
.bg{background:transparent;color:var(--muted);border:1px solid var(--bdr)}.bg:hover{border-color:var(--gold);color:var(--gold)}
.btn:disabled{opacity:.35;cursor:not-allowed}
.wf{width:100%}
input{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;color:var(--text);font-family:'Noto Serif JP',serif;padding:8px 11px;font-size:.8rem;outline:none;transition:border-color .2s}
input:focus{border-color:var(--gold)}
.msg{margin-bottom:10px;animation:fu .2s ease}
@keyframes fu{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.mh{display:flex;align-items:baseline;gap:5px;margin-bottom:2px}
.mn{font-weight:700;font-size:.76rem}
.mn-ai{color:var(--gold)}.mn-hu{color:#77ccff}.mn-gm{color:#aa88ff}.mn-sr{color:#66ddff}
.mt{font-size:.57rem;color:var(--muted)}.mb{font-size:.83rem;line-height:1.76;color:var(--text)}
.msg-gm{background:rgba(70,30,140,.12);border-left:3px solid var(--purple);padding:5px 8px;border-radius:0 7px 7px 0}
.msg-gm .mb{color:#ccbbff;font-size:.74rem}
.msg-sr{background:rgba(0,80,120,.18);border-left:3px solid #66ddff;padding:5px 8px;border-radius:0 7px 7px 0}
.msg-sr .mb{color:#99eeff;font-size:.8rem}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;margin-top:6px}
.pc{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;padding:8px;text-align:center;transition:all .14s;cursor:default}
.pc.sel{cursor:pointer;border-color:#5533aa}.pc.sel:hover{border-color:var(--gold)}
.pc.picked{border-color:var(--red);background:rgba(150,0,0,.14)}
.pe{font-size:1.25rem;margin-bottom:1px}.pn{font-size:.67rem;font-weight:700}
.vlist{display:flex;flex-direction:column;gap:6px}
.vi{background:var(--surf2);border:1px solid var(--bdr);border-radius:9px;padding:9px 12px;display:flex;align-items:center;gap:8px;cursor:pointer;transition:all .14s}
.vi:hover:not(.vd){border-color:var(--gold)}.vi.vs{border-color:var(--red);background:rgba(140,0,0,.12)}.vi.vd{cursor:default;opacity:.55}
.rsgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:6px}
.rsi{background:var(--surf2);border:1px solid var(--bdr);border-radius:9px;padding:8px;display:flex;align-items:center;justify-content:space-between}
.ril{display:flex;align-items:center;gap:5px}.rem{font-size:1.1rem}.rn{font-size:.74rem;font-weight:700}.rt{font-size:.56rem;color:var(--muted)}
.ni{display:flex;align-items:center;gap:3px}
.nb{width:19px;height:19px;border-radius:50%;border:1px solid var(--bdr);background:var(--surf);color:var(--text);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:.82rem}
.nb:hover{border-color:var(--gold);color:var(--gold)}.nv{font-size:.8rem;font-weight:700;min-width:15px;text-align:center}
.tot{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;padding:7px 11px;display:flex;justify-content:space-between;align-items:center;margin-top:7px}
.ok{color:var(--green)}.bad{color:var(--red)}
.ri{padding:7px 10px;background:var(--surf2);border-radius:7px;margin-bottom:3px;font-size:.76rem;border-left:3px solid var(--gold)}
.ri.b{border-color:var(--red)}.ri.i{border-color:var(--blue)}
.exec-wrap{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;text-align:center}
.exec-emo{font-size:3.5rem;margin-bottom:14px}
.exec-name{font-family:'Zen Antique',serif;font-size:1.7rem;color:#ffaaaa;margin-bottom:8px}
.exec-msg{font-size:.82rem;color:var(--muted);margin-bottom:18px;line-height:1.8}
.np{background:rgba(12,0,30,.5);border:1px solid var(--purple);border-radius:11px;padding:14px;margin-bottom:10px}
.nt{color:#bb99ff;font-size:.88rem;margin-bottom:8px;letter-spacing:.07em}
.gos{text-align:center;padding:26px 14px}
.got{font-family:'Zen Antique',serif;font-size:1.6rem;color:var(--gold);margin-bottom:10px}
.wbw{display:flex;gap:7px;justify-content:center;flex-wrap:wrap;margin:11px 0}
.wb{padding:6px 13px;border-radius:13px;font-weight:700;font-size:.8rem}
.wv{background:rgba(0,40,0,.6);color:#66ff88;border:1px solid var(--green)}
.ww{background:rgba(70,0,0,.6);color:#ff8888;border:1px solid var(--red)}
.w3{background:rgba(15,0,50,.6);color:#bb99ff;border:1px solid var(--purple)}
.rgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:5px;margin-top:9px}
.rc{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;padding:8px;text-align:center}
.dban{background:rgba(80,0,0,.18);border:1px solid var(--red);border-radius:8px;padding:7px 10px;margin-bottom:8px;font-size:.72rem;color:#ff9999;text-align:center}
.dead-roles{background:rgba(20,0,40,.3);border:1px solid var(--purple);border-radius:9px;padding:11px;margin-bottom:10px}
.dead-roles-title{color:#bb99ff;font-size:.75rem;margin-bottom:8px}
.fl{display:flex}.g2{gap:8px}.mb2{margin-bottom:8px}.mb3{margin-bottom:10px}
.ts{font-size:.74rem}.tx{font-size:.63rem}.tm{color:var(--muted)}.tg{color:var(--gold)}.fb{font-weight:700}
.mt2{margin-top:8px}.mt3{margin-top:9px}
.thi{color:var(--muted);font-size:.63rem}
.thi::after{content:'';animation:d 1.2s steps(3,end) infinite}
@keyframes d{0%{content:''}33%{content:'.'}66%{content:'..'}100%{content:'...'}}
@media(max-width:520px){.hdr h1{font-size:1.45rem}.pgrid{grid-template-columns:repeat(3,1fr)}.rsgrid{grid-template-columns:1fr 1fr}}
`;

// ─────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────
function NI({ v, onChange, min=0, max=5 }) {
  return (
    <div className="ni">
      <button className="nb" onClick={() => onChange(Math.max(min,v-1))}>−</button>
      <span className="nv">{v}</span>
      <button className="nb" onClick={() => onChange(Math.min(max,v+1))}>＋</button>
    </div>
  );
}

function Msg({ m }) {
  const nc = m.type==="gm"?"mn-gm":m.isSeer?"mn-sr":m.isHuman?"mn-hu":"mn-ai";
  const cls = m.type==="gm"?"msg msg-gm":m.isSeer?"msg msg-sr":"msg";
  return (
    <div className={cls}>
      {m.sender&&<div className="mh"><span className={`mn ${nc}`}>{m.sender}</span><span className="mt">{m.time}</span></div>}
      <div className="mb">{m.text}</div>
    </div>
  );
}

function TBar({ sec, total }) {
  const pct=Math.max(0,(sec/total)*100);
  const urg=sec<=30;
  const mm=String(Math.floor(sec/60)).padStart(2,"0");
  const ss=String(sec%60).padStart(2,"0");
  return (
    <div className="tbar">
      <div className="tbar-row">
        <span className="tl" style={{color:urg?"#ff7777":"var(--gold)"}}>⏱ {mm}:{ss}</span>
        <span className="tr">{urg?"⚠️ まもなく投票":"昼の議論（4分）"}</span>
      </div>
      <div className="ttrack"><div className="tfill" style={{width:`${pct}%`,background:urg?"#cc3333":"var(--gold)"}}/></div>
    </div>
  );
}

function DeadRolesPanel({ players }) {
  return (
    <div className="dead-roles">
      <div className="dead-roles-title">👁 役職一覧（死亡者のみ閲覧可）</div>
      <div className="rgrid">
        {players.map(p=>(
          <div key={p.id} className="rc">
            <div style={{fontSize:"1.1rem"}}>{ROLES[p.role]?.emoji}</div>
            <div className="ts fb mt2">{p.name}{p.isHuman?" 👤":""}</div>
            <div className="tx tm">{ROLES[p.role]?.name}</div>
            {!p.alive&&<div className="tx" style={{color:"var(--red)"}}>死亡</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
export default function App() {
  const [phase, setPhase] = useState(PHASES.LOBBY);
  const [humanName, setHumanName] = useState("");
  const [cfg, setCfg] = useState({...DEFAULT_CFG});
  const [players, setPlayers] = useState([]);
  const [chat, setChat] = useState([]);
  const [wChat, setWChat] = useState([]);
  const [input, setInput] = useState("");
  const [myVote, setMyVote] = useState(null);
  const [aiVotes, setAiVotes] = useState({});
  const [selTgt, setSelTgt] = useState(null);
  const [nightAct, setNightAct] = useState({});
  const [day, setDay] = useState(1);
  const [winners, setWinners] = useState([]);
  const [endPlayers, setEndPlayers] = useState([]);
  const [thinking, setThinking] = useState(false);
  const [timerSec, setTimerSec] = useState(DAY_SEC);
  const [timerOn, setTimerOn] = useState(false);
  const [execInfo, setExecInfo] = useState(null);

  const chatBodyRef = useRef(null);
  const userScrolledRef = useRef(false);
  const procRef = useRef(false);
  const timerRef = useRef(null);
  const autoRef = useRef(null);
  const plRef = useRef([]);
  const chRef = useRef([]);
  const phRef = useRef(PHASES.LOBBY);
  const dayRef = useRef(1);
  const voteDoneRef = useRef(false);

  useEffect(()=>{plRef.current=players;},[players]);
  useEffect(()=>{chRef.current=chat;},[chat]);
  useEffect(()=>{phRef.current=phase;},[phase]);
  useEffect(()=>{dayRef.current=day;},[day]);

  // スクロール制御：ユーザーが上を見ていなければ自動スクロール
  useEffect(()=>{
    const el=chatBodyRef.current;
    if(!el)return;
    const isNearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<150;
    if(isNearBottom||!userScrolledRef.current){
      el.scrollTop=el.scrollHeight;
    }
  },[chat]);

  // ユーザーのスクロール検知
  useEffect(()=>{
    const el=chatBodyRef.current;
    if(!el)return;
    const onScroll=()=>{
      const isNearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<100;
      userScrolledRef.current=!isNearBottom;
    };
    el.addEventListener("scroll",onScroll);
    return()=>el.removeEventListener("scroll",onScroll);
  },[]);

  useEffect(()=>{
    if(timerOn){
      timerRef.current=setInterval(()=>{
        setTimerSec(p=>{if(p<=1){clearInterval(timerRef.current);setTimerOn(false);return 0;}return p-1;});
      },1000);
    }
    return()=>clearInterval(timerRef.current);
  },[timerOn]);

  useEffect(()=>{
    if(timerSec===0&&phRef.current===PHASES.DAY&&!voteDoneRef.current){
      voteDoneRef.current=true;doVotePhase();
    }
  },[timerSec]);

  useEffect(()=>{
    if(phase!==PHASES.DAY){if(autoRef.current)clearTimeout(autoRef.current);return;}
    const schedule=()=>{
      autoRef.current=setTimeout(()=>{
        if(phRef.current===PHASES.DAY&&!procRef.current){
          runAITurn(plRef.current,chRef.current,null,false);
        }
        schedule();
      },14000+Math.random()*10000);
    };
    schedule();
    return()=>{if(autoRef.current)clearTimeout(autoRef.current);};
  },[phase]);

  const now=()=>new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"});
  const mk=m=>({...m,time:now(),id:Date.now()+Math.random()});
  const addC=useCallback(m=>{setChat(p=>[...p,mk(m)]);},[]);
  const addW=useCallback(m=>{setWChat(p=>[...p,mk(m)]);},[]);

  const myP=players.find(p=>p.isHuman);
  const alive=players.filter(p=>p.alive);
  const isDead=myP&&!myP.alive;
  const total=Object.values(cfg).reduce((a,b)=>a+b,0);
  const totalW=(cfg.WEREWOLF||0)+(cfg.MADMAN||0);
  const totalV=total-totalW-(cfg.WITCH||0)-(cfg.TRAITOR||0);
  const bwarn=totalW>=totalV;
  const wolfAllies=myP&&myP.role==="WEREWOLF"
    ?players.filter(p=>p.role==="WEREWOLF"&&p.id!==myP.id):[];

  function startGame(){
    if(!humanName.trim()||(total+1)<8||(total+1)>10)return;
    let pl=buildPlayers(humanName,cfg);
    setPlayers(pl);plRef.current=pl;
    setPhase(PHASES.DAY);phRef.current=PHASES.DAY;
    setDay(1);dayRef.current=1;
    setChat([]);chRef.current=[];setWChat([]);setExecInfo(null);
    setTimerSec(DAY_SEC);setTimerOn(true);voteDoneRef.current=false;
    userScrolledRef.current=false;
    const baker=pl.find(p=>p.role==="BAKER"&&p.alive);
    const txt=`第1日目の朝が始まりました。${pl.length}人の村人たちよ、人狼を探し出せ！${baker?" 🍞 どこからかパンの焼ける匂いがします。":""}`;
    const first=mk({type:"gm",sender:"🎲 GM",text:txt,isHuman:false});
    setChat([first]);chRef.current=[first];
    setTimeout(()=>runOpenings(pl,[first]),1200);
  }

  async function runOpenings(pl,ch){
    if(procRef.current)return;
    procRef.current=true;setThinking(true);
    const ais=[...pl.filter(p=>!p.isHuman&&p.alive)].sort(()=>Math.random()-.5).slice(0,3);
    for(let i=0;i<ais.length;i++){
      await wait(800+Math.random()*1000);
      const ai=ais[i];
      const prompt=buildFullPrompt(ai,ai.memory,pl,ch,1,null,null)+"\n最初の挨拶や自己紹介（1〜2文）：";
      let text=await callGemini(prompt);
      if(!text) text=`こんにちは、${ai.name}です。よろしくお願いします。`;
      // メモリに保存
      const updPl=plRef.current.map(p=>p.id===ai.id?{...p,memory:{...p.memory,pastStatements:[...p.memory.pastStatements,{day:1,text}]}}:p);
      setPlayers(updPl);plRef.current=updPl;
      const m=mk({type:"ai",sender:ai.name,text,isHuman:false});
      setChat(p=>[...p,m]);ch=[...ch,m];chRef.current=ch;
    }
    setThinking(false);procRef.current=false;
  }

  // ─────────────────────────────────────────────────────────────
  // AIターン（完全LLM駆動）
  // ─────────────────────────────────────────────────────────────
  async function runAITurn(pl,ch,trigger,isHumanTrigger){
    if(procRef.current)return;
    procRef.current=true;setThinking(true);
    const aiAlive=pl.filter(p=>!p.isHuman&&p.alive);
    if(!aiAlive.length){setThinking(false);procRef.current=false;return;}

    // 発言者の選定
    let speakers=[];
    if(trigger&&isHumanTrigger){
      // 人間発言：全AIが反応候補。名指しされたAIは必ず。全員への質問は2〜3人が反応
      const namedAIs=aiAlive.filter(ai=>trigger.text.includes(ai.name));
      const hasGlobalQuestion=/[？?]|みんな|全員|誰か|役職|占い師|霊媒師|騎士/.test(trigger.text);
      const rest=[...aiAlive.filter(ai=>!namedAIs.some(n=>n.id===ai.id))].sort(()=>Math.random()-.5);
      const reactors=hasGlobalQuestion?rest.slice(0,2):rest.slice(0,1);
      speakers=[...namedAIs,...reactors];
      if(!speakers.length)speakers=rest.slice(0,2);
    } else if(trigger){
      // AI発言に対してAIが反応
      const namedAIs=aiAlive.filter(ai=>trigger.text.includes(ai.name));
      const rest=[...aiAlive.filter(ai=>!namedAIs.some(n=>n.id===ai.id)&&ai.name!==trigger.sender)].sort(()=>Math.random()-.5);
      speakers=[...namedAIs.slice(0,1),...rest.slice(0,1)];
    } else {
      speakers=[...aiAlive].sort(()=>Math.random()-.5).slice(0,2+Math.floor(Math.random()*2));
    }

    for(let i=0;i<speakers.length;i++){
      await wait(1200+Math.random()*1600);
      if(phRef.current!==PHASES.DAY)break;
      const ai=speakers[i];
      const currentAi=plRef.current.find(p=>p.id===ai.id);
      if(!currentAi||!currentAi.alive)continue;

      let text="";let isSeer=false;

      // 占い師が未公開の結果を持っている場合、COのチャンス
      if(currentAi.role==="SEER"&&dayRef.current>=2&&currentAi.memory?.seerResults?.length>0){
        const unpub=currentAi.memory.seerResults.filter(r=>
          !currentAi.memory.pastStatements.some(s=>s.text.includes(r.name)&&s.text.includes(r.result))
        );
        if(unpub.length&&Math.random()>0.45){
          const latest=unpub[unpub.length-1];
          const prompt=buildFullPrompt(currentAi,currentAi.memory,plRef.current,ch,dayRef.current,trigger,null)+
            `\n占い師として昨夜${latest.name}を占い「${latest.result}」という結果を得ました。今このタイミングでCOして結果を公開する発言（1〜2文）：`;
          text=await callGemini(prompt)||`占い師としてCOします。昨夜${latest.name}さんを占いました。結果は${latest.result}でした。`;
          isSeer=true;
          const updPl=plRef.current.map(p=>p.id===currentAi.id?{...p,memory:{...p.memory,claimedRole:"SEER"}}:p);
          setPlayers(updPl);plRef.current=updPl;
        }
      }

      // 通常発言（LLM生成）
      if(!text){
        const humanMsg=isHumanTrigger?trigger:null;
        const prompt=buildFullPrompt(currentAi,currentAi.memory,plRef.current,ch,dayRef.current,trigger,humanMsg);
        text=await callGemini(prompt);

        // フォールバック
        if(!text){
          const isWolf=["WEREWOLF","MADMAN"].includes(currentAi.role);
          const cands=plRef.current.filter(p=>p.alive&&p.id!==currentAi.id&&!currentAi.memory?.wolfAllies?.includes(p.name));
          const target=cands[Math.floor(Math.random()*cands.length)];
          if(trigger&&trigger.text.includes(currentAi.name)){
            text=isWolf
              ?`${trigger.sender}さん、私を疑う根拠はありますか？${target?.name}さんの方が気になります。`
              :`${trigger.sender}さん、私は${ROLES[currentAi.role]?.name}として誠実に行動しています。`;
          } else {
            text=isWolf
              ?`${target?.name}さんの発言に少し引っかかりを感じています。`
              :`${target?.name}さんについて、もう少し詳しく聞かせてもらえますか？`;
          }
        }
      }

      // COの検出・メモリ更新
      let updatedMemory={...currentAi.memory};
      if(text.includes("占い師")&&(text.includes("です")||text.includes("として"))){
        updatedMemory.claimedRole="SEER";
      }
      if(text.includes("霊媒師")&&(text.includes("です")||text.includes("として"))){
        updatedMemory.claimedRole="MEDIUM";
      }
      // 疑い度の更新
      plRef.current.filter(p=>p.alive&&p.id!==currentAi.id).forEach(p=>{
        if(text.includes(p.name)&&/怪し|疑|人狼じゃ|処刑/.test(text)){
          updatedMemory.suspects={...updatedMemory.suspects,[p.name]:Math.min(10,(updatedMemory.suspects[p.name]||3)+1)};
        }
      });
      // 過去発言に追加
      updatedMemory.pastStatements=[...updatedMemory.pastStatements,{day:dayRef.current,text}];

      const updPl=plRef.current.map(p=>p.id===currentAi.id?{...p,memory:updatedMemory}:p);
      setPlayers(updPl);plRef.current=updPl;

      const m=mk({type:"ai",sender:currentAi.name,text,isHuman:false,isSeer});
      setChat(prev=>[...prev,m]);ch=[...ch,m];chRef.current=ch;
    }
    setThinking(false);procRef.current=false;
  }

  function sendChat(){
    if(!input.trim()||!myP?.alive)return;
    const txt=input.trim();setInput("");
    userScrolledRef.current=false;
    const m=mk({type:"human",sender:myP.name,text:txt,isHuman:true});
    setChat(p=>[...p,m]);chRef.current=[...chRef.current,m];
    setTimeout(()=>runAITurn(plRef.current,chRef.current,{sender:myP.name,text:txt},true),400);
  }

  function doVotePhase(){
    if(phRef.current===PHASES.VOTE)return;
    clearInterval(timerRef.current);setTimerOn(false);
    setPhase(PHASES.VOTE);phRef.current=PHASES.VOTE;
    setMyVote(null);setAiVotes({});setSelTgt(null);
    const av={};
    plRef.current.filter(p=>!p.isHuman&&p.alive).forEach(ai=>{
      const id=decideVote(ai,plRef.current);
      if(id)av[ai.id]=id;
    });
    setAiVotes(av);
    setTimeout(()=>addC({type:"gm",sender:"🎲 GM",text:"⏰ 議論終了！投票フェーズです。",isHuman:false}),100);
  }

  function submitVote(){
    if(!selTgt||!myP?.alive)return;
    setMyVote(selTgt);
    const{winnerId,tally}=computeExecution(aiVotes,selTgt);
    const ex=plRef.current.find(p=>p.id===winnerId);if(!ex)return;
    const upd=plRef.current.map(p=>p.id===winnerId?{...p,alive:false}:p);
    setPlayers(upd);plRef.current=upd;
    const summary=Object.entries(tally).sort((a,b)=>b[1]-a[1])
      .map(([id,cnt])=>{const p=plRef.current.find(q=>q.id===id);return`${p?.name||"?"}:${cnt}票`;}).join("、");
    setExecInfo({name:ex.name,role:ex.role,summary});
    setPhase(PHASES.EXECUTION);phRef.current=PHASES.EXECUTION;
  }

  function goToNight(){
    const w=checkWin(plRef.current);
    if(w.over){setWinners(w.winners);setEndPlayers(plRef.current);setPhase(PHASES.GAME_OVER);}
    else startNight(plRef.current);
  }

  function startNight(pl){
    setPhase(PHASES.NIGHT);phRef.current=PHASES.NIGHT;
    setNightAct({});setSelTgt(null);
    addC({type:"gm",sender:"🎲 GM",text:"🌙 夜になりました。各役職は行動してください。",isHuman:false});
    if(myP?.role==="WEREWOLF"&&myP.alive)addW({type:"wolf",sender:"🐺 人狼チャット",text:"今夜は誰を狙う？作戦を立てよう。",isHuman:false});
    const acts={};
    pl.filter(p=>!p.isHuman&&p.alive&&["WEREWOLF","SEER","KNIGHT","ILLUSIONIST","WITCH"].includes(p.role)).forEach(ai=>{
      const cands=pl.filter(q=>q.alive&&q.id!==ai.id);if(!cands.length)return;
      if(ai.role==="WEREWOLF"){
        const wolfIds=pl.filter(q=>q.role==="WEREWOLF").map(q=>q.id);
        const prio=cands.filter(q=>["SEER","KNIGHT","MEDIUM"].includes(q.role));
        const safe=cands.filter(q=>!wolfIds.includes(q.id));
        const pool=prio.length?prio:safe.length?safe:cands;
        acts[ai.id]=pool[Math.floor(Math.random()*pool.length)].id;
      } else if(ai.role==="ILLUSIONIST"){
        // 幻術師は1回のみ使用可能
        if(!ai.memory?.illusionistUsed){
          acts[ai.id]=cands[Math.floor(Math.random()*cands.length)].id;
        }
      } else {
        acts[ai.id]=cands[Math.floor(Math.random()*cands.length)].id;
      }
    });
    setNightAct(acts);
    const hp=pl.find(p=>p.isHuman);
    if(!hp?.alive||!["SEER","KNIGHT","ILLUSIONIST","WITCH","WEREWOLF"].includes(hp?.role)){
      setTimeout(()=>resolveNight(acts,pl),3000);
    }
  }

  function submitNight(){
    if(!selTgt)return;
    const acts={...nightAct,[myP.id]:selTgt};
    setNightAct(acts);resolveNight(acts,plRef.current);
  }

  function resolveNight(acts,pl){
    let upd=[...pl];const prot=new Set();let redir=null;
    Object.entries(acts).forEach(([aid,tid])=>{
      const a=upd.find(p=>p.id===aid);
      if(a?.role==="KNIGHT"&&a.alive)prot.add(tid);
    });
    Object.entries(acts).forEach(([aid,tid])=>{
      const a=upd.find(p=>p.id===aid);
      if(a?.role==="ILLUSIONIST"&&a.alive&&!a.memory?.illusionistUsed){
        redir=tid;
        // 幻術師の能力使用済みフラグを立てる
        upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,illusionistUsed:true}}:p);
      }
    });
    const we=Object.entries(acts).filter(([aid])=>{const a=upd.find(p=>p.id===aid);return a?.role==="WEREWOLF"&&a.alive;});
    const results=[];
    if(we.length){
      const atk=redir||we[0][1];
      if(prot.has(atk)){results.push({t:"今夜は騎士が誰かを守りました！",tp:"g"});}
      else{
        const v=upd.find(p=>p.id===atk);
        if(v?.alive){
          upd=upd.map(p=>p.id===atk?{...p,alive:false}:p);
          results.push({t:`${v.name} が人狼に襲われました。`,tp:"b"});
        }
      }
    }else{results.push({t:"今夜は平和でした。",tp:"i"});}

    // 占い師の結果処理
    Object.entries(acts).forEach(([aid,tid])=>{
      const a=upd.find(p=>p.id===aid);
      if(a?.role==="SEER"&&a.alive){
        const tg=upd.find(p=>p.id===tid);
        if(tg){
          const res=tg.role==="WEREWOLF"?"人狼":"村人";
          const seerResult={name:tg.name,result:res,day:dayRef.current};
          upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,seerResults:[...p.memory.seerResults,seerResult]}}:p);
          if(a.isHuman)results.push({t:`🔮 占い結果: ${tg.name}を占いました。結果は${res}でした。`,tp:"i"});
        }
      }
    });

    // 霊媒師の結果処理（前日の処刑者の役職を確認）
    const lastExecuted=execInfo;
    if(lastExecuted){
      Object.entries(acts).forEach(([aid])=>{
        const a=upd.find(p=>p.id===aid);
        if(a?.role==="MEDIUM"&&a.alive){
          const executedPlayer=plRef.current.find(p=>p.name===lastExecuted.name);
          if(executedPlayer){
            const res=executedPlayer.role==="WEREWOLF"?"人狼":"村人";
            const medResult={name:lastExecuted.name,result:res,day:dayRef.current};
            upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,mediumResults:[...p.memory.mediumResults,medResult]}}:p);
            if(a.isHuman)results.push({t:`👻 霊媒結果: ${lastExecuted.name}の正体は${res}でした。`,tp:"i"});
          }
        }
      });
    }

    setPlayers(upd);plRef.current=upd;
    const nd=dayRef.current+1;setDay(nd);dayRef.current=nd;
    const w=checkWin(upd);
    if(w.over){setWinners(w.winners);setEndPlayers(upd);setTimeout(()=>setPhase(PHASES.GAME_OVER),1500);}
    else{
      setTimeout(()=>{
        setPhase(PHASES.DAY);phRef.current=PHASES.DAY;
        setTimerSec(DAY_SEC);setTimerOn(true);
        setMyVote(null);setAiVotes({});setSelTgt(null);voteDoneRef.current=false;
        userScrolledRef.current=false;
        const baker=upd.find(p=>p.role==="BAKER"&&p.alive);
        const msgs=[
          mk({type:"gm",sender:"🎲 GM",text:`☀️ 第${nd}日目の朝が始まりました。`,isHuman:false}),
          ...results.map(r=>mk({type:"gm",sender:"🎲 GM",text:r.t,isHuman:false})),
          ...(baker?[mk({type:"gm",sender:"🎲 GM",text:"🍞 どこからかパンの焼ける匂いがします。",isHuman:false})]:[]),
        ];
        setChat(p=>[...p,...msgs]);chRef.current=[...chRef.current,...msgs];
        setTimeout(()=>runAITurn(upd,chRef.current,null,false),1500);
      },2500);
    }
  }

  function reset(){
    setPhase(PHASES.LOBBY);setPlayers([]);setChat([]);setWChat([]);
    setDay(1);setWinners([]);setEndPlayers([]);
    setTimerOn(false);setTimerSec(DAY_SEC);setHumanName("");
    setExecInfo(null);voteDoneRef.current=false;userScrolledRef.current=false;
  }

  return (
    <>
      <Head><title>🐺 人狼ゲーム</title><meta name="viewport" content="width=device-width,initial-scale=1"/></Head>
      <style>{CSS}</style>
      <div className="app">
        <div className="hdr">
          <h1>🐺 人狼ゲーム</h1>
          <div className="sub">AI会話型（Gemini搭載）</div>
          {phase===PHASES.DAY&&<div className="pill p-day">☀️ 第{day}日目 昼</div>}
          {phase===PHASES.VOTE&&<div className="pill p-vote">🗳️ 投票中</div>}
          {phase===PHASES.EXECUTION&&<div className="pill p-exec">⚖️ 処刑</div>}
          {phase===PHASES.NIGHT&&<div className="pill p-night">🌙 夜</div>}
        </div>

        {phase===PHASES.LOBBY&&(
          <div className="scroll">
            <div className="card">
              <div className="ct">🏠 ゲームを作成</div>
              <div className="mb3">
                <div className="ts mb2">あなたの名前</div>
                <input style={{width:"100%"}} placeholder="名前を入力" value={humanName}
                  onChange={e=>setHumanName(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&humanName.trim()&&setPhase(PHASES.ROLE_SETUP)}/>
              </div>
              <button className="btn bp" disabled={!humanName.trim()} onClick={()=>setPhase(PHASES.ROLE_SETUP)}>役職設定へ →</button>
            </div>
          </div>
        )}

        {phase===PHASES.ROLE_SETUP&&(
          <div className="scroll">
            <div className="card">
              <div className="ct">⚙️ 役職設定（あなた含め合計8〜10人）</div>
              <div className="rsgrid">
                {Object.entries(ROLES).map(([id,r])=>(
                  <div key={id} className="rsi">
                    <div className="ril"><span className="rem">{r.emoji}</span>
                      <div><div className="rn">{r.name}</div><div className="rt">{r.team==="village"?"村人":r.team==="werewolf"?"人狼":"第三"}</div></div>
                    </div>
                    <NI v={cfg[id]||0} onChange={v=>setCfg(p=>({...p,[id]:v}))}/>
                  </div>
                ))}
              </div>
              <div className="tot">
                <span className="ts">合計（あなた含む）</span>
                <span className={`fb ${(total+1)>=8&&(total+1)<=10?"ok":"bad"}`}>{total+1} / 8〜10人</span>
              </div>
              {bwarn&&<div className="ri b mt2 ts">⚠️ 人狼陣営が強すぎます。</div>}
              <div className="ri i mt2 ts">※ あなた1人分は自動加算されます</div>
              <div className="fl g2 mt3">
                <button className="btn bg" onClick={()=>setPhase(PHASES.LOBBY)}>← 戻る</button>
                <button className="btn bp" disabled={(total+1)<8||(total+1)>10} onClick={startGame}>ゲーム開始！</button>
              </div>
            </div>
          </div>
        )}

        {phase===PHASES.DAY&&(
          <div className="day-wrap">
            <div className="day-top">
              <TBar sec={timerSec} total={DAY_SEC}/>
              {myP&&(
                <div className="myrole">
                  <span className="mre">{ROLES[myP.role]?.emoji}</span>
                  <div>
                    <div className="mrn">{myP.name}（あなた）{!myP.alive&&" 💀"}</div>
                    <div className="mrd">役職: {ROLES[myP.role]?.name}</div>
                    {myP.memory?.seerResults?.length>0&&(
                      <div className="mri">📋 {myP.memory.seerResults.map(r=>`${r.name}:${r.result}`).join(" / ")}</div>
                    )}
                  </div>
                </div>
              )}
              {myP?.role==="WEREWOLF"&&wolfAllies.length>0&&(
                <div className="wolf-info">🐺 仲間の人狼: {wolfAllies.map(w=>w.name).join("、")}</div>
              )}
            </div>

            {isDead?(
              <div className="scroll" style={{flex:1}}>
                <div className="dban">💀 死亡しました。観戦モードです。</div>
                <DeadRolesPanel players={players}/>
                <div className="card">
                  <div className="ct ts">💬 会話ログ（観戦）</div>
                  <div style={{maxHeight:300,overflowY:"auto"}}>{chat.map(m=><Msg key={m.id} m={m}/>)}</div>
                </div>
              </div>
            ):(
              <>
                <div className="chat-main">
                  <div className="chat-hdr">
                    <span className="ts tg fb">💬 昼の議論</span>
                    {thinking&&<span className="thi">AIが考え中</span>}
                    <span className="tx tm">生存:{alive.length}人</span>
                  </div>
                  <div className="chat-body" ref={chatBodyRef}>
                    {chat.map(m=><Msg key={m.id} m={m}/>)}
                  </div>
                  <div className="chat-foot">
                    <input placeholder="発言を入力…（Enterで送信）" value={input}
                      onChange={e=>setInput(e.target.value)}
                      onKeyDown={e=>e.key==="Enter"&&sendChat()}
                      disabled={!myP?.alive}/>
                    <button className="send-btn" onClick={sendChat} disabled={!myP?.alive||!input.trim()}>送信</button>
                  </div>
                </div>
                <div className="vote-area">
                  <button className="btn bp wf" onClick={()=>{voteDoneRef.current=true;doVotePhase();}}>
                    🗳️ 議論終了・投票へ
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {phase===PHASES.VOTE&&(
          <div className="scroll">
            {myP&&(
              <div className="myrole">
                <span className="mre">{ROLES[myP.role]?.emoji}</span>
                <div><div className="mrn">{myP.name}</div><div className="mrd">役職: {ROLES[myP.role]?.name}</div></div>
              </div>
            )}
            {isDead?(
              <div className="card">
                <div className="dban">💀 死亡しているため投票できません。</div>
                <DeadRolesPanel players={players}/>
              </div>
            ):(
              <div className="card">
                <div className="ct">🗳️ 処刑する人物を選んでください</div>
                <div className="ri i mb2 ts">※ AIとの多数決で処刑者が決まります</div>
                <div className="vlist">
                  {alive.filter(p=>!p.isHuman).map(p=>(
                    <div key={p.id} className={`vi${selTgt===p.id?" vs":""}${myVote?" vd":""}`}
                      onClick={()=>!myVote&&setSelTgt(p.id)}>
                      <span style={{fontSize:"1rem"}}>🤖</span>
                      <span className="fb ts" style={{flex:1}}>{p.name}</span>
                      {selTgt===p.id&&!myVote&&<span className="tx tg">← 選択中</span>}
                    </div>
                  ))}
                </div>
                {!myVote
                  ?<button className="btn bd wf mt3" disabled={!selTgt} onClick={submitVote}>投票する</button>
                  :<div className="ri i mt3">✅ 投票完了。集計中…</div>
                }
              </div>
            )}
            <div className="card">
              <div className="ct ts">💬 会話ログ</div>
              <div style={{maxHeight:180,overflowY:"auto"}}>{chat.map(m=><Msg key={m.id} m={m}/>)}</div>
            </div>
          </div>
        )}

        {phase===PHASES.EXECUTION&&execInfo&&(
          <div className="exec-wrap">
            <div className="exec-emo">⚖️</div>
            <div className="exec-name">{execInfo.name}</div>
            <div className="exec-msg">
              村人たちの投票により、<strong>{execInfo.name}</strong> が処刑されました。<br/>
              <span style={{fontSize:".72rem",color:"var(--muted)",display:"block",marginTop:8}}>【投票結果】{execInfo.summary}</span>
              <span style={{fontSize:".76rem",marginTop:12,display:"block",color:"#ffbbbb"}}>役職は秘密です。</span>
            </div>
            <button className="btn bp" onClick={goToNight}>夜へ進む →</button>
          </div>
        )}

        {phase===PHASES.NIGHT&&(
          <div className="scroll">
            <div className="np">
              <div className="nt">🌙 夜が訪れた</div>
              {myP?.role==="WEREWOLF"&&myP.alive&&wolfAllies.length>0&&(
                <div className="wolf-info mb2">🐺 仲間の人狼: {wolfAllies.map(w=>w.name).join("、")}</div>
              )}
              {myP?.role==="WEREWOLF"&&myP.alive&&(
                <div className="mb3">
                  <div className="ct ts">🐺 人狼チャット（秘密）</div>
                  <div style={{maxHeight:80,overflowY:"auto"}}>{wChat.map(m=><Msg key={m.id} m={m}/>)}</div>
                </div>
              )}
              {myP?.alive&&["SEER","KNIGHT","ILLUSIONIST","WITCH","WEREWOLF"].includes(myP.role)&&!nightAct[myP.id]?(
                <div>
                  <div className="ts tg mb2">
                    {myP.role==="SEER"&&"🔮 占う相手を選んでください（毎夜1人）"}
                    {myP.role==="KNIGHT"&&"🛡️ 守る相手を選んでください"}
                    {myP.role==="ILLUSIONIST"&&(myP.memory?.illusionistUsed?"✨ 幻術師の能力は使用済みです":"✨ 人狼の攻撃を向ける相手を選んでください（1回のみ）")}
                    {myP.role==="WITCH"&&"🧙 呪う相手を選んでください"}
                    {myP.role==="WEREWOLF"&&"🐺 襲撃する相手を選んでください"}
                  </div>
                  {!(myP.role==="ILLUSIONIST"&&myP.memory?.illusionistUsed)&&(
                    <>
                      <div className="pgrid">
                        {alive.filter(p=>!p.isHuman).map(p=>(
                          <div key={p.id} className={`pc sel${selTgt===p.id?" picked":""}`} onClick={()=>setSelTgt(p.id)}>
                            <div className="pe">🤖</div><div className="pn">{p.name}</div>
                          </div>
                        ))}
                      </div>
                      <button className="btn bp mt3" disabled={!selTgt} onClick={submitNight}>決定</button>
                    </>
                  )}
                  {myP.role==="ILLUSIONIST"&&myP.memory?.illusionistUsed&&(
                    <button className="btn bg mt3" onClick={()=>resolveNight(nightAct,plRef.current)}>夜を終える</button>
                  )}
                </div>
              ):myP?.alive?(
                <div className="ts tm">あなたの役職には夜の行動がありません。しばらくお待ちください…</div>
              ):(
                <div>
                  <div className="dban">💀 死亡中。役職を確認できます。</div>
                  <DeadRolesPanel players={players}/>
                </div>
              )}
            </div>
          </div>
        )}

        {phase===PHASES.GAME_OVER&&(
          <div className="scroll">
            <div className="gos">
              <div className="got">⚔️ ゲーム終了</div>
              <div className="wbw">
                {winners.map(w=>(
                  <span key={w} className={`wb ${w.includes("村人")?"wv":w.includes("人狼")?"ww":"w3"}`}>🏆 {w} の勝利！</span>
                ))}
              </div>
              <div className="card" style={{textAlign:"left"}}>
                <div className="ct">全員の役職公開</div>
                <div className="rgrid">
                  {endPlayers.map(p=>(
                    <div key={p.id} className="rc">
                      <div style={{fontSize:"1.15rem"}}>{ROLES[p.role]?.emoji}</div>
                      <div className="ts fb mt2">{p.name}{p.isHuman?" 👤":""}</div>
                      <div className="tx tm">{ROLES[p.role]?.name}</div>
                      {!p.alive&&<div className="tx" style={{color:"var(--red)"}}>死亡</div>}
                    </div>
                  ))}
                </div>
              </div>
              <button className="btn bp mt3" onClick={reset}>🔄 もう一度プレイ</button>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

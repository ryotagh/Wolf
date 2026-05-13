import { useState, useEffect, useRef, useCallback } from "react";
import Head from "next/head";

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

const PHASES = { LOBBY:"LOBBY", ROLE_SETUP:"ROLE_SETUP", DAY:"DAY", VOTE:"VOTE", EXECUTION:"EXECUTION", NIGHT:"NIGHT", GAME_OVER:"GAME_OVER" };
const AI_NAMES = ["きなこ","ぷち","ココア","つくね","うさぎ","くりまんじゅう","ハチワレ","ちいかわ","鎧さん"];
const DEFAULT_CFG = { VILLAGER:3, WEREWOLF:2, SEER:1, KNIGHT:1, MADMAN:1 };
const DAY_SEC = 150;
const rnd = a => a[Math.floor(Math.random() * a.length)];
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// GEMINI
// ─────────────────────────────────────────────────────────────
// サーバーサイドAPI経由でGeminiを呼ぶ（APIキーを隠す）
// 429時はnullを返してフォールバック発言を使う
async function gemini(prompt) {
  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text || null;
  } catch { return null; }
}

async function callLLM(prompt) { return await gemini(prompt); }

// 1回のAPIで複数AIの発言をまとめて生成（リクエスト節約）
async function geminiMulti(speakers, allPlayers, chatLog, day, trigger) {
  if (!speakers.length) return [];
  // callLLM経由でGemini→OpenRouterフォールバック


  const alive = allPlayers.filter(p => p.alive);
  const dead = allPlayers.filter(p => !p.alive);
  const log = chatLog.filter(m => m.type !== "gm").slice(-8)
    .map(m => `${m.sender}「${m.text}」`).join("\n");
  const triggerLine = trigger ? `直前の発言：${trigger.sender}「${trigger.text}」` : "";

  // 全員の情報をコンパクトにまとめる
  const speakerInfos = speakers.map(sp => {
    const isWolf = ["WEREWOLF","MADMAN"].includes(sp.role);
    const wolfAllies = isWolf && sp.memory?.wolfAllies?.length
      ? `（仲間の人狼：${sp.memory.wolfAllies.join("、")}）` : "";
    const seerInfo = sp.role === "SEER" && sp.memory?.seerResults?.length
      ? `占い結果：${sp.memory.seerResults.map(r=>`${r.name}→${r.result}`).join("、")}` : "";
    const suspects = Object.entries(sp.memory?.suspects||{}).filter(([,v])=>v>=5).map(([n])=>n).join("、")||"なし";
    const pastSaid = (sp.memory?.said||[]).slice(-3).join(" / ") || "なし";
    const roleGoal = isWolf
      ? `人狼。村人のふりをして${wolfAllies}村人陣営を処刑に誘導する。嘘をつく。`
      : sp.role === "SEER" ? `占い師。${seerInfo}。適切なタイミングでCOして情報を共有する。`
      : `${sp.memory?.role || sp.role}（村人陣営）。人狼を見つけて処刑に誘導する。`;
    return `【${sp.name}】役割：${roleGoal} 性格：${sp.personality} 疑っている人：${suspects} 過去発言：${pastSaid}`;
  }).join("\n");

  const prompt = `あなたは人狼ゲームのGMです。以下のプレイヤーそれぞれが、今この状況でどう発言するか生成してください。

ゲーム状況：${day}日目の昼
生存者：${alive.map(p=>p.name).join("、")}
死亡者：${dead.length?dead.map(p=>p.name).join("、"):"なし"}
${triggerLine}

直近の会話：
${log || "（まだなし）"}

各プレイヤーの情報：
${speakerInfos}

【出力形式】必ず以下の形式で各プレイヤーの発言を出力してください。他の文字は一切不要。
${speakers.map(sp => `${sp.name}：（発言内容）`).join("\n")}

【発言のルール】
- 直前の会話・質問に必ず反応する（無視禁止）
- 具体的な名前と根拠を含める（抽象的な発言禁止）
- 役職の目標に沿った戦略的な発言
- 1〜2文の自然な日本語
- 各自の性格に合わせた話し方
- 過去発言と矛盾しない`;

  // Gemini→OpenRouterフォールバックで1リクエスト
  const raw = await callLLM(prompt);
  if (!raw) return [];
  return speakers.map(sp => {
    const regex = new RegExp(`${sp.name}[：:」]([^\n]+)`);
    const match = raw.match(regex);
    let text = match ? match[1].trim() : null;
    if (text) {
      text = text.replace(/^[「」]+|[「」]+$/g, "").trim();
      if (text.length > 250) text = text.slice(0, 250) + "。";
    }
    return { speaker: sp, text };
  });
}

// ─────────────────────────────────────────────────────────────
// CORE PROMPT - 自由に考えさせる
// ─────────────────────────────────────────────────────────────
function makePrompt(speaker, allPlayers, chatLog, day, trigger) {
  const alive = allPlayers.filter(p => p.alive);
  const dead = allPlayers.filter(p => !p.alive);
  const isWolf = ["WEREWOLF","MADMAN"].includes(speaker.role);
  const isSeer = speaker.role === "SEER";
  const isMedium = speaker.role === "MEDIUM";
  const mem = speaker.memory;

  // 直近10発言
  const log = chatLog.filter(m => m.type !== "gm").slice(-10)
    .map(m => `${m.sender}「${m.text}」`).join("\n");

  // 自分の過去発言（直近5件）
  const past = (mem.said || []).slice(-5).map(s => `・${s}`).join("\n") || "なし";

  // 占い結果
  const seerLog = (mem.seerResults || []).map(r => `${r.day}日目夜：${r.name}→${r.result}`).join("、") || "なし";

  // 霊媒結果
  const medLog = (mem.medResults || []).map(r => `${r.name}→${r.result}`).join("、") || "なし";

  // 人狼専用：仲間情報
  const wolfSection = isWolf && mem.wolfAllies?.length > 0
    ? `\n【仲間の人狼（これは絶対に秘密。口外厳禁）】${mem.wolfAllies.join("、")}`
    : "";

  // CO状況
  const coInfo = allPlayers
    .filter(p => p.memory?.claimedRole)
    .map(p => `${p.name}→${ROLES[p.memory.claimedRole]?.name}とCO`).join("、") || "なし";

  // 直前発言
  const triggerLine = trigger
    ? `\n直前の発言（これに必ず反応すること）：\n${trigger.sender}「${trigger.text}」`
    : "";

  // 役職別の目標と情報
  let roleInfo = "";
  if (speaker.role === "WEREWOLF") {
    roleInfo = `
あなたは人狼です。目標：村人陣営を処刑に誘導して人狼が生き残ること。
仲間の人狼を守れ。自分への疑いは他の村人に向けろ。嘘をつけ。
偽占い師として名乗り出ることも有効（タイミングを見て）。
絶対に人狼だとバレるな。村人として自然に振る舞え。${wolfSection}`;
  } else if (speaker.role === "MADMAN") {
    roleInfo = `
あなたは狂人です。人狼陣営を勝たせることが目標（人狼が誰かは知らない）。
村人陣営を混乱させろ。偽情報を流せ。偽COも有効。`;
  } else if (isSeer) {
    roleInfo = `
あなたは占い師です。占い結果：${seerLog}
結果を持っているなら適切なタイミングでCOして共有すること。
偽占い師が出たら「本物は私だ」と主張せよ。
まだ結果がないなら潜伏してもよい。`;
  } else if (isMedium) {
    roleInfo = `
あなたは霊媒師です。処刑された人の正体がわかる。霊媒結果：${medLog}
結果があれば公開を検討せよ。`;
  } else if (speaker.role === "KNIGHT") {
    roleInfo = `あなたは騎士です。夜に誰かを守れる。役職は隠しながら議論に参加せよ。`;
  } else {
    roleInfo = `あなたは${ROLES[speaker.role]?.name}（村人陣営）です。人狼を見つけて処刑に誘導せよ。`;
  }

  return `あなたは人狼ゲーム中のプレイヤー「${speaker.name}」です。
今から、このゲームの中で「${speaker.name}」として発言してください。

${roleInfo}

【現在の状況】
・${day}日目の昼
・生存：${alive.map(p=>p.name).join("、")}
・死亡：${dead.length?dead.map(p=>p.name).join("、"):"なし"}
・役職CO状況：${coInfo}

【自分の記憶】
・自分の過去発言：
${past}
・占い結果：${seerLog}
・霊媒結果：${medLog}
・疑っている人：${Object.entries(mem.suspects||{}).filter(([,v])=>v>=4).map(([n])=>n).join("、")||"特になし"}
・信頼している人：${Object.entries(mem.trusted||{}).filter(([,v])=>v>=4).map(([n])=>n).join("、")||"特になし"}
${triggerLine}

【直近の会話】
${log || "（まだ発言なし）"}

【重要な指示】
1. 直前の発言・質問には必ず反応すること。無視厳禁。
2. 「${speaker.name}さんへの疑いが強まっています」のような抽象的な発言は禁止。必ず具体的な名前と根拠を出せ。
3. 自分の過去発言と矛盾するな。
4. 実際に起きていないことを「昨日〜した」と言うな。
5. 発言は1〜2文の自然な日本語のみ。余計な記号不要。
6. 毎回違う言い方をすること。同じ表現を繰り返すな。
7. ${speaker.personality}な性格で話すこと。

今この瞬間の「${speaker.name}」の発言：`;
}

// ─────────────────────────────────────────────────────────────
// FALLBACK（API失敗時）
// ─────────────────────────────────────────────────────────────
const FALLBACKS = {
  WEREWOLF: (name, target, accuser) => accuser
    ? [`${accuser}さん、その根拠はなんですか？私は普通にゲームしてるだけです。`, `${accuser}さんこそ、なぜ私ばかり疑うんでしょう。`]
    : [`${target}さんの動きがどうも引っかかります。みなさんはどう思いますか？`, `${target}さん、さっきの発言もう少し詳しく説明してもらえますか？`],
  SEER: (name, info) => info
    ? [`占い師として報告します。${info}`, `情報を共有します。${info}`]
    : [`まだはっきりしたことは言えませんが、気になる人がいます。`, `様子を見ながら判断しています。`],
  DEFAULT: (name, target) => [
    `${target}さん、なぜそういう発言をしたのか聞かせてもらえますか？`,
    `${target}さんについて、もう少し情報が欲しいです。`,
    `今の議論の流れ、少し整理しませんか？`,
  ],
};

function fallback(speaker, allPlayers, trigger) {
  const isWolf = ["WEREWOLF","MADMAN"].includes(speaker.role);
  const alive = allPlayers.filter(p => p.alive && p.id !== speaker.id);
  const wolfAllies = (speaker.memory?.wolfAllies || []);
  const safeTargets = alive.filter(p => !wolfAllies.includes(p.name));
  const target = safeTargets[Math.floor(Math.random() * safeTargets.length)]?.name || alive[0]?.name || "？";
  const accuser = trigger?.text.includes(speaker.name) ? trigger.sender : null;

  if (isWolf) return rnd(FALLBACKS.WEREWOLF(speaker.name, target, accuser));
  if (speaker.role === "SEER") {
    const latest = speaker.memory?.seerResults?.slice(-1)[0];
    const info = latest ? `${latest.name}さんを占いました。結果は${latest.result}でした。` : null;
    return rnd(FALLBACKS.SEER(speaker.name, info));
  }
  return rnd(FALLBACKS.DEFAULT(speaker.name, target));
}

// ─────────────────────────────────────────────────────────────
// PLAYERS
// ─────────────────────────────────────────────────────────────
const PERSONALITIES = ["論理的","感情的","疑い深い","積極的","慎重","天然","強引","冷静"];

function initMemory(role, wolfAllies = []) {
  return {
    role,
    wolfAllies,          // 仲間の人狼名リスト
    claimedRole: null,
    seerResults: [],     // [{name, result, day}]
    medResults: [],      // [{name, result}]
    said: [],            // 過去発言テキスト
    suspects: {},        // {name: 0-10}
    trusted: {},         // {name: 0-10}
    voteHistory: [],
    illusionistUsed: false,
  };
}

function buildPlayers(humanName, cfg) {
  const roles = [];
  Object.entries(cfg).forEach(([r,c]) => { for(let i=0;i<c;i++) roles.push(r); });
  const shuffled = [...roles].sort(() => Math.random() - 0.5);
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);

  // 人狼同士の名前リストを作成
  const wolfIndexes = shuffled.reduce((acc, r, i) => { if(r==="WEREWOLF") acc.push(i); return acc; }, []);
  const getWolfName = (idx) => idx === 0 ? (humanName.trim()||"あなた") : names[(idx-1) % names.length];

  const players = [{
    id:"human", name:humanName.trim()||"あなた", isHuman:true,
    role:shuffled[0], alive:true,
    personality: rnd(PERSONALITIES),
    memory: initMemory(shuffled[0], shuffled[0]==="WEREWOLF" ? wolfIndexes.filter(i=>i!==0).map(getWolfName) : []),
  }];

  for (let i=1; i<shuffled.length; i++) {
    const role = shuffled[i];
    const wolfAllies = role === "WEREWOLF"
      ? wolfIndexes.filter(idx => idx !== i).map(getWolfName)
      : [];
    players.push({
      id: `ai_${i}`,
      name: names[(i-1) % names.length],
      isHuman: false,
      role, alive: true,
      personality: PERSONALITIES[(i-1) % PERSONALITIES.length],
      memory: initMemory(role, wolfAllies),
    });
  }
  return players;
}

function checkWin(players) {
  const al=players.filter(p=>p.alive);
  const aw=al.filter(p=>p.role==="WEREWOLF");
  const av=al.filter(p=>!["WEREWOLF","WITCH","TRAITOR"].includes(p.role));
  if(!aw.length){const w=["村人陣営"];if(al.find(p=>p.role==="WITCH"))w.push("魔女");if(al.find(p=>p.role==="TRAITOR"))w.push("裏切り者");return{over:true,winners:w};}
  if(aw.length>=av.length){const w=["人狼陣営"];if(al.find(p=>p.role==="WITCH"))w.push("魔女");if(al.find(p=>p.role==="TRAITOR"))w.push("裏切り者");return{over:true,winners:w};}
  return{over:false,winners:[]};
}

function computeExecution(aiVotes, humanVote) {
  const t={};
  Object.values(aiVotes).forEach(id=>{t[id]=(t[id]||0)+1;});
  if(humanVote)t[humanVote]=(t[humanVote]||0)+1;
  const mx=Math.max(...Object.values(t));
  const tied=Object.entries(t).filter(([,v])=>v===mx).map(([id])=>id);
  return{winnerId:tied[Math.floor(Math.random()*tied.length)],tally:t};
}

function decideVote(ai, allPlayers, chatLog) {
  const cands=allPlayers.filter(p=>p.alive&&p.id!==ai.id);
  if(!cands.length)return null;
  const isWolf=["WEREWOLF","MADMAN"].includes(ai.role);
  if(isWolf){
    // 人狼：仲間以外で人間プレイヤーを避ける傾向（バレやすいので）
    const wolfNames=[...(ai.memory?.wolfAllies||[]),ai.name];
    const targets=cands.filter(p=>!wolfNames.includes(p.name));
    const nonHuman=targets.filter(p=>!p.isHuman);
    const pool=nonHuman.length&&Math.random()>0.3?nonHuman:targets;
    return(pool.length?pool:cands)[Math.floor(Math.random()*(pool.length||cands.length))].id;
  }
  // 村人陣営：占い結果優先→会話での疑い頻度→自分の疑い度
  const knownWolf=cands.find(p=>(ai.memory?.seerResults||[]).some(r=>r.name===p.name&&r.result==="人狼"));
  if(knownWolf)return knownWolf.id;
  const suspicionCount={};
  cands.forEach(p=>{suspicionCount[p.name]=0;});
  if(chatLog){
    chatLog.filter(m=>m.type!=="gm").slice(-20).forEach(m=>{
      cands.forEach(p=>{
        if(m.text.includes(p.name)&&/怪し|疑|人狼じゃ|処刑|投票/.test(m.text)){
          suspicionCount[p.name]=(suspicionCount[p.name]||0)+1;
        }
      });
    });
  }
  const sus=ai.memory?.suspects||{};
  const scored=cands.map(p=>({id:p.id,score:(sus[p.name]||3)+(suspicionCount[p.name]||0)*2})).sort((a,b)=>b.score-a.score);
  return scored[0]?.id||cands[Math.floor(Math.random()*cands.length)].id;
}

// ─────────────────────────────────────────────────────────────
// CSS
// ─────────────────────────────────────────────────────────────
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Noto+Serif+JP:wght@400;700;900&family=Zen+Antique&display=swap');
:root{--bg:#0a0a0f;--surf:#12121a;--surf2:#1a1a26;--bdr:#2a2a3a;--gold:#c8a96e;--red:#cc3333;--blue:#4477dd;--green:#33aa66;--purple:#7744cc;--text:#e8e0d0;--muted:#9090a0;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;background:var(--bg);color:var(--text);font-family:'Noto Serif JP',serif;}
.app{display:flex;flex-direction:column;height:100vh;max-width:820px;margin:0 auto}
.scroll{overflow-y:auto;flex:1;padding:14px}
.scroll::-webkit-scrollbar{width:3px}.scroll::-webkit-scrollbar-thumb{background:var(--bdr)}
.day-wrap{flex:1;display:flex;flex-direction:column;overflow:hidden;padding:0 12px 12px}
.day-top{flex-shrink:0;padding-bottom:6px}
.chat-main{flex:1;display:flex;flex-direction:column;overflow:hidden;background:var(--surf);border:1px solid var(--bdr);border-radius:11px;min-height:0}
.chat-hdr{display:flex;justify-content:space-between;align-items:center;padding:8px 12px;border-bottom:1px solid var(--bdr);flex-shrink:0}
.chat-body{flex:1;overflow-y:auto;padding:10px;min-height:0}
.chat-body::-webkit-scrollbar{width:3px}.chat-body::-webkit-scrollbar-thumb{background:var(--bdr);border-radius:3px}
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
.btn:disabled{opacity:.35;cursor:not-allowed}.wf{width:100%}
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
      <button className="nb" onClick={()=>onChange(Math.max(min,v-1))}>−</button>
      <span className="nv">{v}</span>
      <button className="nb" onClick={()=>onChange(Math.min(max,v+1))}>＋</button>
    </div>
  );
}

function Msg({ m }) {
  const nc=m.type==="gm"?"mn-gm":m.isSeer?"mn-sr":m.isHuman?"mn-hu":"mn-ai";
  const cls=m.type==="gm"?"msg msg-gm":m.isSeer?"msg msg-sr":"msg";
  return (
    <div className={cls}>
      {m.sender&&<div className="mh"><span className={`mn ${nc}`}>{m.sender}</span><span className="mt">{m.time}</span></div>}
      <div className="mb">{m.text}</div>
    </div>
  );
}

function TBar({ sec, total }) {
  const pct=Math.max(0,(sec/total)*100), urg=sec<=30;
  const mm=String(Math.floor(sec/60)).padStart(2,"0"), ss=String(sec%60).padStart(2,"0");
  return (
    <div className="tbar">
      <div className="tbar-row">
        <span className="tl" style={{color:urg?"#ff7777":"var(--gold)"}}>⏱ {mm}:{ss}</span>
        <span className="tr">{urg?"⚠️ まもなく投票":"昼の議論（2分30秒）"}</span>
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
// APP
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
  const atBottomRef = useRef(true);
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

  // スクロール（ユーザーが下にいる時だけ追従）
  useEffect(()=>{
    const el=chatBodyRef.current; if(!el)return;
    if(atBottomRef.current) el.scrollTop=el.scrollHeight;
  },[chat]);

  useEffect(()=>{
    const el=chatBodyRef.current; if(!el)return;
    const fn=()=>{ atBottomRef.current=(el.scrollHeight-el.scrollTop-el.clientHeight)<120; };
    el.addEventListener("scroll",fn);
    return()=>el.removeEventListener("scroll",fn);
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
      voteDoneRef.current=true; doVotePhase();
    }
  },[timerSec]);

  useEffect(()=>{
    if(phase!==PHASES.DAY){if(autoRef.current)clearTimeout(autoRef.current);return;}
    const sched=()=>{
      autoRef.current=setTimeout(()=>{
        if(phRef.current===PHASES.DAY&&!procRef.current) runAITurn(plRef.current,chRef.current,null,false);
        sched();
      },45000+Math.random()*15000);
    };
    sched();
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
  const wolfAllies=myP?.role==="WEREWOLF"?players.filter(p=>p.role==="WEREWOLF"&&p.id!==myP.id):[];

  function startGame(){
    if(!humanName.trim()||(total+1)<8||(total+1)>10)return;
    const pl=buildPlayers(humanName,cfg);
    setPlayers(pl);plRef.current=pl;
    setPhase(PHASES.DAY);phRef.current=PHASES.DAY;
    setDay(1);dayRef.current=1;
    setChat([]);chRef.current=[];setWChat([]);setExecInfo(null);
    setTimerSec(DAY_SEC);setTimerOn(true);voteDoneRef.current=false;atBottomRef.current=true;
    const baker=pl.find(p=>p.role==="BAKER"&&p.alive);
    const txt=`第1日目の朝が始まりました。${pl.length}人の村人たちよ、人狼を探し出せ！${baker?" 🍞 パンの焼ける匂いがします。":""}`;
    const first=mk({type:"gm",sender:"🎲 GM",text:txt,isHuman:false});
    setChat([first]);chRef.current=[first];
    setTimeout(()=>runOpenings(pl,[first]),1200);
  }

  async function runOpenings(pl,ch){
    if(procRef.current)return;
    procRef.current=true;
    // 初回挨拶はGemini不使用（リクエスト節約）
    const greetings=[
      n=>`${n}です。よろしくお願いします。`,
      n=>`${n}と申します。みんなで人狼を見つけましょう。`,
      n=>`${n}です。慎重に議論しましょう。`,
      n=>`${n}です！絶対に人狼を見つけます！`,
      n=>`よろしく、${n}です。`,
    ];
    const ais=[...pl.filter(p=>!p.isHuman&&p.alive)].sort(()=>Math.random()-.5).slice(0,3);
    for(let i=0;i<ais.length;i++){
      await wait(600+Math.random()*800);
      const ai=ais[i];
      const text=greetings[Math.floor(Math.random()*greetings.length)](ai.name);
      const m=mk({type:"ai",sender:ai.name,text,isHuman:false});
      const updPl=plRef.current.map(p=>p.id===ai.id?{...p,memory:{...p.memory,said:[...(p.memory.said||[]),text]}}:p);
      setPlayers(updPl);plRef.current=updPl;
      setChat(p=>[...p,m]);ch=[...ch,m];chRef.current=ch;
    }
    procRef.current=false;
  }

  async function runAITurn(pl,ch,trigger,fromHuman){
    if(procRef.current)return;
    procRef.current=true;setThinking(true);
    const aiAlive=pl.filter(p=>!p.isHuman&&p.alive);
    if(!aiAlive.length){setThinking(false);procRef.current=false;return;}

    // 発言者選定：常に最大2人まで（1ターン1リクエストを守る）
    let speakerList=[];
    if(trigger&&fromHuman){
      // 名前を呼ばれたAI1人 + ランダム1人
      const named=aiAlive.filter(ai=>trigger.text.includes(ai.name)).slice(0,1);
      const rest=[...aiAlive.filter(ai=>!named.some(n=>n.id===ai.id))].sort(()=>Math.random()-.5);
      speakerList=[...named,...rest.slice(0,1)];
      if(!speakerList.length)speakerList=rest.slice(0,1);
    } else if(trigger){
      const named=aiAlive.filter(ai=>trigger.text.includes(ai.name)&&ai.name!==trigger.sender).slice(0,1);
      const rest=[...aiAlive.filter(ai=>ai.name!==trigger.sender&&!named.some(n=>n.id===ai.id))].sort(()=>Math.random()-.5);
      speakerList=[...named,...rest.slice(0,1)];
    } else {
      // 自動発言：1人だけ
      speakerList=[...aiAlive].sort(()=>Math.random()-.5).slice(0,1);
    }

    // 占い師が結果を持っている場合は個別処理
    let seerHandled = false;
    for(const sp of speakerList){
      const base=plRef.current.find(p=>p.id===sp.id);
      if(!base||!base.alive)continue;
      if(base.role==="SEER"&&dayRef.current>=2){
        const results=base.memory?.seerResults||[];
        const published=base.memory?.said?.join("")||"";
        const unpub=results.filter(r=>!published.includes(r.name));
        if(unpub.length&&Math.random()>0.4){
          const r=unpub[unpub.length-1];
          const text=await gemini(
            `占い師として「${r.name}を昨夜占いました。結果は${r.result}でした」という情報を、今のゲーム状況（${day}日目）で自然にCOする発言を1〜2文で生成してください。直前の会話：${ch.filter(m=>m.type!=="gm").slice(-3).map(m=>m.sender+"「"+m.text+"」").join(" ")}`
          )||`占い師としてCOします。昨夜${r.name}さんを占いました。結果は${r.result}でした。`;
          await wait(1500);
          if(phRef.current!==PHASES.DAY)break;
          const updPl=plRef.current.map(p=>p.id===base.id?{...p,memory:{...p.memory,claimedRole:"SEER",said:[...(p.memory.said||[]),text]}}:p);
          setPlayers(updPl);plRef.current=updPl;
          const m=mk({type:"ai",sender:base.name,text,isHuman:false,isSeer:true});
          setChat(prev=>[...prev,m]);ch=[...ch,m];chRef.current=ch;
          speakerList=speakerList.filter(s=>s.id!==sp.id);
          seerHandled=true;
          break;
        }
      }
    }

    if(!speakerList.length){setThinking(false);procRef.current=false;return;}

    // 残りのスピーカーを1回のAPIでまとめて生成（リクエスト節約）
    await wait(1000);
    if(phRef.current!==PHASES.DAY){setThinking(false);procRef.current=false;return;}

    const currentSpeakers=speakerList.map(sp=>plRef.current.find(p=>p.id===sp.id)).filter(p=>p&&p.alive);
    const results=await geminiMulti(currentSpeakers,plRef.current,ch,dayRef.current,trigger);

    for(let i=0;i<results.length;i++){
      if(phRef.current!==PHASES.DAY)break;
      const {speaker:base,text:rawText}=results[i];
      const text=rawText||fallback(base,plRef.current,trigger);

      // メモリ更新
      let mem={...base.memory};
      mem.said=[...(mem.said||[]),text];
      if(text.includes("占い師")&&(text.includes("です")||text.includes("として"))){mem.claimedRole="SEER";}
      if(text.includes("霊媒師")&&(text.includes("です")||text.includes("として"))){mem.claimedRole="MEDIUM";}
      plRef.current.filter(p=>p.alive&&p.id!==base.id).forEach(p=>{
        if(text.includes(p.name)){
          if(/怪し|疑|人狼じゃ|処刑|偽/.test(text)){
            mem.suspects={...mem.suspects,[p.name]:Math.min(10,(mem.suspects[p.name]||3)+1)};
          }
          if(/信頼|本物|正しい|村人だ/.test(text)){
            mem.trusted={...mem.trusted,[p.name]:Math.min(10,(mem.trusted[p.name]||3)+1)};
          }
        }
      });

      const updPl=plRef.current.map(p=>p.id===base.id?{...p,memory:mem}:p);
      setPlayers(updPl);plRef.current=updPl;

      const m=mk({type:"ai",sender:base.name,text,isHuman:false,isSeer:false});
      setChat(prev=>[...prev,m]);ch=[...ch,m];chRef.current=ch;
      if(i<results.length-1) await wait(1500+Math.random()*1000);
    }
    setThinking(false);procRef.current=false;
  }

  function sendChat(){
    if(!input.trim()||!myP?.alive)return;
    const txt=input.trim();setInput("");
    atBottomRef.current=true;
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
      const id=decideVote(ai,plRef.current,chRef.current);
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
    if(myP?.role==="WEREWOLF"&&myP.alive)addW({type:"wolf",sender:"🐺 人狼チャット",text:"今夜は誰を狙う？",isHuman:false});
    const acts={};
    pl.filter(p=>!p.isHuman&&p.alive&&["WEREWOLF","SEER","KNIGHT","ILLUSIONIST","WITCH"].includes(p.role)).forEach(ai=>{
      const cands=pl.filter(q=>q.alive&&q.id!==ai.id);if(!cands.length)return;
      if(ai.role==="WEREWOLF"){
        const wolfNames=[...(ai.memory?.wolfAllies||[]),ai.name];
        // 優先：占い師・騎士・霊媒師（脅威役職）→ 人間以外のAI → 全体
        // 人間プレイヤーを直接狙いにくくして人間が早死にしすぎるのを防ぐ
        const safeCands=cands.filter(q=>!wolfNames.includes(q.name));
        const prioRoles=safeCands.filter(q=>["SEER","KNIGHT","MEDIUM"].includes(q.role)&&!q.isHuman);
        const aiOnly=safeCands.filter(q=>!q.isHuman);
        // 人間を狙う確率を下げる（30%以下）
        let pool;
        if(prioRoles.length) pool=prioRoles;
        else if(aiOnly.length&&Math.random()>0.3) pool=aiOnly;
        else pool=safeCands.length?safeCands:cands;
        acts[ai.id]=pool[Math.floor(Math.random()*pool.length)].id;
      } else if(ai.role==="ILLUSIONIST"&&!ai.memory?.illusionistUsed){
        acts[ai.id]=cands[Math.floor(Math.random()*cands.length)].id;
      } else if(ai.role!=="ILLUSIONIST"){
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
        upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,illusionistUsed:true}}:p);
      }
    });
    const we=Object.entries(acts).filter(([aid])=>{const a=upd.find(p=>p.id===aid);return a?.role==="WEREWOLF"&&a.alive;});
    const results=[];
    if(we.length){
      const atk=redir||we[0][1];
      if(prot.has(atk)){results.push({t:"今夜は騎士が誰かを守りました！"});}
      else{
        const v=upd.find(p=>p.id===atk);
        if(v?.alive){upd=upd.map(p=>p.id===atk?{...p,alive:false}:p);results.push({t:`${v.name}が人狼に襲われました。`});}
      }
    }else{results.push({t:"今夜は平和でした。"});}

    // 占い結果
    Object.entries(acts).forEach(([aid,tid])=>{
      const a=upd.find(p=>p.id===aid);
      if(a?.role==="SEER"&&a.alive){
        const tg=upd.find(p=>p.id===tid);
        if(tg){
          const res=tg.role==="WEREWOLF"?"人狼":"村人";
          const sr={name:tg.name,result:res,day:dayRef.current};
          upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,seerResults:[...(p.memory.seerResults||[]),sr]}}:p);
          if(a.isHuman)results.push({t:`🔮 占い結果：${tg.name}→${res}`});
        }
      }
    });

    // 霊媒結果（前の処刑者）
    if(execInfo){
      Object.entries(acts).forEach(([aid])=>{
        const a=upd.find(p=>p.id===aid);
        if(a?.role==="MEDIUM"&&a.alive){
          const exPl=pl.find(p=>p.name===execInfo.name);
          if(exPl){
            const res=exPl.role==="WEREWOLF"?"人狼":"村人";
            const mr={name:execInfo.name,result:res};
            upd=upd.map(p=>p.id===aid?{...p,memory:{...p.memory,medResults:[...(p.memory.medResults||[]),mr]}}:p);
            if(a.isHuman)results.push({t:`👻 霊媒結果：${execInfo.name}→${res}`});
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
        setMyVote(null);setAiVotes({});setSelTgt(null);voteDoneRef.current=false;atBottomRef.current=true;
        const baker=upd.find(p=>p.role==="BAKER"&&p.alive);
        const msgs=[
          mk({type:"gm",sender:"🎲 GM",text:`☀️ 第${nd}日目の朝が始まりました。`,isHuman:false}),
          ...results.map(r=>mk({type:"gm",sender:"🎲 GM",text:r.t,isHuman:false})),
          ...(baker?[mk({type:"gm",sender:"🎲 GM",text:"🍞 パンの焼ける匂いがします。",isHuman:false})]:[]),
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
    setExecInfo(null);voteDoneRef.current=false;atBottomRef.current=true;
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
                    <button className="send-btn" onClick={sendChat} disabled={!myP?.alive||!input.trim()||thinking}>送信</button>
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
              村人たちの投票により、<strong>{execInfo.name}</strong>が処刑されました。<br/>
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

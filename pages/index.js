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

const PHASES = {
  LOBBY:"LOBBY", ROLE_SETUP:"ROLE_SETUP",
  DAY:"DAY", VOTE:"VOTE", EXECUTION:"EXECUTION",
  NIGHT:"NIGHT", GAME_OVER:"GAME_OVER"
};

const AI_NAMES = ["きなこ","ぷち","ココア","つくね","うさぎ","くりまんじゅう","ハチワレ","ちいかわ","鎧さん"];
const DEFAULT_CFG = { VILLAGER:3, WEREWOLF:2, SEER:1, KNIGHT:1, MADMAN:1 };
const DAY_SEC = 240;
const rnd = a => a[Math.floor(Math.random() * a.length)];
const wait = ms => new Promise(r => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────
// GEMINI API
// ─────────────────────────────────────────────────────────────
async function callGemini(systemPrompt, userMessage) {
  try {
    const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) return null;

    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: fullPrompt }] }],
          generationConfig: {
            maxOutputTokens: 120,
            temperature: 1.0,
            topP: 0.95,
          },
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
    // クリーニング
    text = text.replace(/^[\s「」『』"']+|[\s「」『』"']+$/g, "").trim();
    if (text.length > 120) text = text.substring(0, 120) + "…";
    return text;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// AI SYSTEM PROMPT BUILDER
// 役職・状況・会話履歴を完全に把握させる
// ─────────────────────────────────────────────────────────────
function buildSystemPrompt(ai, allPlayers, chatLog, day) {
  const isWolf = ["WEREWOLF", "MADMAN"].includes(ai.role);
  const isSeer = ai.role === "SEER";
  const role = ROLES[ai.role];
  const alive = allPlayers.filter(p => p.alive);
  const dead = allPlayers.filter(p => !p.alive);

  // 仲間の人狼
  const wolfAllies = isWolf
    ? allPlayers.filter(p => p.role === "WEREWOLF" && p.id !== ai.id).map(p => p.name)
    : [];

  // 直近の会話（最大8件）
  const recentChat = chatLog
    .filter(m => m.type !== "gm")
    .slice(-8)
    .map(m => `${m.sender}: ${m.text}`)
    .join("\n");

  // 占い師の知っている情報
  const seerInfo = ai.knownInfo?.length > 0
    ? `\n【あなたが占いで得た情報】\n${ai.knownInfo.join("\n")}`
    : "";

  // 処刑された人
  const executedInfo = dead.length > 0
    ? `\n【これまでに処刑・死亡した人】${dead.map(p => p.name).join("、")}`
    : "";

  // 役職別の詳細な戦略指示
  let roleStrategy = "";

  if (ai.role === "WEREWOLF") {
    roleStrategy = `
【あなたは人狼です。以下の戦略を取ってください】
・絶対に村人のふりをする。「私は村人です」と明言してもよい
・仲間の人狼（${wolfAllies.join("、") || "なし"}）を守る。彼らへの疑いは別に向ける
・積極的に村人陣営の誰かを疑って誘導する
・時には「占い師として言います〜が人狼でした」と偽装して混乱させる（3日目以降推奨）
・質問されたら嘘をついて答える
・他の人の発言の矛盾を突いて信用を失わせる
・自分への疑いが集まったら逆に攻撃に転じる
`;
  } else if (ai.role === "MADMAN") {
    roleStrategy = `
【あなたは狂人です。人狼陣営を勝たせるために動いてください】
・自分が人狼かどうかは分からないが、村人陣営を混乱させることが目標
・でたらめな情報を流す、間違った人を疑わせる
・「占い師です」と名乗って偽情報を流すのも効果的
・積極的に場を乱す発言をする
`;
  } else if (ai.role === "SEER") {
    roleStrategy = `
【あなたは占い師です】
・得た情報（${ai.knownInfo?.join("、") || "まだなし"}）を適切なタイミングで公開する
・早すぎると人狼に狙われる。遅すぎると情報が活かせない
・偽占い師が現れたら「本物の占い師は私です」と主張して反論する
・カミングアウトする際は「占い師として正式に報告します」と明言する
・質問されたら慎重に答える（占い師であることは状況次第で公開してよい）
`;
  } else if (ai.role === "KNIGHT") {
    roleStrategy = `
【あなたは騎士です】
・役職を隠しながら議論に参加する
・怪しい人物への疑いを共有する
・「騎士として誰かを守っています」とカミングアウトするのは効果的な場合もある
`;
  } else {
    roleStrategy = `
【あなたは${role.name}（村人陣営）です】
・人狼を見つけることが目標
・論理的な推理と感情的な訴えを使い分ける
・怪しいと思う人を積極的に指摘する
・質問されたら正直に答える
`;
  }

  return `あなたは人狼ゲームのキャラクター「${ai.name}」です。

【基本情報】
・役職: ${role.name}
・性格: ${ai.personality}型（論理的/感情的/疑い深い/積極的/慎重/天然などで振る舞う）
・現在: ${day}日目の昼
・生存者: ${alive.map(p => p.name).join("、")}${executedInfo}${seerInfo}

${roleStrategy}

【会話の絶対ルール】
1. 必ず直前の会話の流れを読んで、それに対して自然に返答する
2. 自分の名前が出たり、質問されたりしたら必ずそれに答える
3. 「様子がおかしい」「怪しい」だけでなく、具体的な根拠や名前を出して発言する
4. 1〜2文の短い日本語のみ。余計な記号・括弧・説明不要
5. 同じ発言を繰り返さない
6. 役職カミングアウトは戦略的に判断して行う（隠し続けなくてもよい）
7. 生き生きとした個性ある発言をする

【直近の会話】
${recentChat || "（まだ発言なし）"}`;
}

// ─────────────────────────────────────────────────────────────
// 誰への発言か・何を聞かれているかを解析
// ─────────────────────────────────────────────────────────────
function analyzeMessage(text, speakerName, allPlayers) {
  const alive = allPlayers.filter(p => p.alive);

  // 名指しされたプレイヤー
  const mentioned = alive.filter(p => text.includes(p.name) && p.name !== speakerName);

  // 質問の種類を検出
  const isQuestion = /[？?]/.test(text) ||
    ["いますか", "ですか", "ますか", "でしょ", "どう思", "なんで", "なぜ", "教えて", "誰が", "誰です"].some(w => text.includes(w));

  // 占い師について聞いているか
  const askingSeer = text.includes("占い師");

  // 役職について聞いているか
  const askingRole = text.includes("役職") || text.includes("何者") || text.includes("正体");

  // 全員への問いかけか
  const toAll = text.includes("みんな") || text.includes("誰か") || text.includes("みなさん") || (!mentioned.length && isQuestion);

  return { mentioned, isQuestion, askingSeer, askingRole, toAll };
}

// ─────────────────────────────────────────────────────────────
// AIの発言を生成（役割と状況を完全に把握）
// ─────────────────────────────────────────────────────────────
async function generateAISpeech(ai, allPlayers, chatLog, day, trigger) {
  const systemPrompt = buildSystemPrompt(ai, allPlayers, chatLog, day);

  let userMessage = "あなたの発言（1〜2文）:";

  if (trigger) {
    const analysis = analyzeMessage(trigger.text, trigger.sender, allPlayers);

    // 自分が名指しされた
    if (analysis.mentioned.some(p => p.id === ai.id)) {
      userMessage = `${trigger.sender}があなた（${ai.name}）に直接言及しました: 「${trigger.text}」
あなたはこれに必ず応答してください。無視は絶対にしないでください。
あなたの役職に基づいた返答（1〜2文）:`;
    }
    // 占い師について質問された
    else if (analysis.askingSeer && analysis.toAll) {
      const isSeer = ai.role === "SEER";
      const isWolf = ["WEREWOLF", "MADMAN"].includes(ai.role);
      if (isSeer && Math.random() > 0.3) {
        userMessage = `${trigger.sender}が「${trigger.text}」と聞きました。
あなたは占い師です。カミングアウトするかどうか判断して答えてください。
カミングアウトする場合は「占い師です。${ai.knownInfo?.length ? ai.knownInfo[ai.knownInfo.length-1] : "まだ占い結果はありません。"}」と答えてください。
あなたの返答（1〜2文）:`;
      } else if (isWolf && Math.random() > 0.6) {
        userMessage = `${trigger.sender}が「${trigger.text}」と聞きました。
あなたは人狼ですが、偽の占い師として名乗り出るチャンスです（推奨）。
または村人として「いると思いますが私ではありません」と答えることもできます。
あなたの返答（1〜2文）:`;
      } else {
        userMessage = `${trigger.sender}が「${trigger.text}」と聞きました。
全員への質問です。あなたはこれに自然に反応してください。
あなたの返答（1〜2文）:`;
      }
    }
    // 役職について質問された
    else if (analysis.askingRole && analysis.toAll) {
      userMessage = `${trigger.sender}が「${trigger.text}」と全員に聞きました。
あなたの役職（${ROLES[ai.role].name}）に基づいて、公開するかどうか判断して返答してください。
あなたの返答（1〜2文）:`;
    }
    // 全員への質問
    else if (analysis.isQuestion && analysis.toAll && Math.random() > 0.5) {
      userMessage = `${trigger.sender}が全員に「${trigger.text}」と聞きました。
あなたはこの質問に自分の役職・立場から答えてください。
あなたの返答（1〜2文）:`;
    }
    // 誰かへの発言に反応
    else {
      userMessage = `直前の発言: ${trigger.sender}「${trigger.text}」
この発言を受けて、あなたはどう反応しますか？
自分の役職・戦略に基づいて具体的に返答してください（1〜2文）:`;
    }
  } else {
    // 自発的な発言
    userMessage = `会話の流れを読んで、あなた（${ai.name}）として自発的に発言してください。
具体的な名前や根拠を出して、役職に沿った戦略的な発言をしてください（1〜2文）:`;
  }

  const result = await callGemini(systemPrompt, userMessage);
  return result;
}

// ─────────────────────────────────────────────────────────────
// フォールバック（API失敗時）
// ─────────────────────────────────────────────────────────────
function fallbackSpeech(ai, allPlayers, trigger, day) {
  const isWolf = ["WEREWOLF", "MADMAN"].includes(ai.role);
  const alive = allPlayers.filter(p => p.alive && p.id !== ai.id);
  const wolfAllies = isWolf
    ? allPlayers.filter(p => p.role === "WEREWOLF" && p.id !== ai.id).map(p => p.id)
    : [];
  const targets = alive.filter(p => !wolfAllies.includes(p.id));
  const target = targets[Math.floor(Math.random() * targets.length)] || alive[0];

  if (trigger) {
    const { sender, text } = trigger;
    if (text.includes(ai.name)) {
      return isWolf
        ? `${sender}さん、私を疑うのは間違いです。${target?.name}さんの方がよほど怪しいですよ。`
        : `${sender}さん、私は村人です。なぜ私を疑うんですか？`;
    }
    if (text.includes("占い師")) {
      if (ai.role === "SEER") return `占い師として言います。昨夜${ai.knownInfo?.[ai.knownInfo.length-1] || "情報を得ました"}。`;
      if (isWolf && day >= 3) return `占い師として言いますが、${target?.name}さんが人狼でした。`;
      return `占い師がいるなら情報を出してほしいですね。`;
    }
    return isWolf
      ? `${sender}さん、それより${target?.name}さんが気になります。`
      : `${sender}さん、その通りですね。${target?.name}さんについてもっと話しましょう。`;
  }

  if (ai.role === "SEER" && ai.knownInfo?.length && day >= 2) {
    return `占い師として報告します。${ai.knownInfo[ai.knownInfo.length-1]}`;
  }

  return isWolf
    ? `${target?.name}さん、昨日からずっと気になっているんですが、説明してもらえますか？`
    : `${target?.name}さんへの疑いが強まっています。みなさんはどう思いますか？`;
}

// ─────────────────────────────────────────────────────────────
// 投票・夜行動
// ─────────────────────────────────────────────────────────────
function decideVote(ai, allPlayers) {
  const cands = allPlayers.filter(p => p.alive && p.id !== ai.id);
  if (!cands.length) return null;
  const isWolf = ["WEREWOLF", "MADMAN"].includes(ai.role);
  if (isWolf) {
    const wolfIds = allPlayers.filter(p => ["WEREWOLF","MADMAN"].includes(p.role)).map(p => p.id);
    const targets = cands.filter(p => !wolfIds.includes(p.id));
    return (targets.length ? targets : cands)[Math.floor(Math.random() * (targets.length || cands.length))].id;
  }
  const knownWolf = cands.find(p => (ai.knownInfo||[]).some(i => i.includes(p.name) && i.includes("人狼")));
  if (knownWolf) return knownWolf.id;
  const sus = ai.suspicion || {};
  const sorted = [...cands].sort((a,b) => (sus[b.name]||3) - (sus[a.name]||3));
  return sorted[0]?.id || cands[Math.floor(Math.random() * cands.length)].id;
}

// ─────────────────────────────────────────────────────────────
// PLAYER FACTORY
// ─────────────────────────────────────────────────────────────
function buildPlayers(humanName, cfg) {
  const roles = [];
  Object.entries(cfg).forEach(([r,c]) => { for(let i=0;i<c;i++) roles.push(r); });
  const shuffled = [...roles].sort(() => Math.random() - 0.5);
  const names = [...AI_NAMES].sort(() => Math.random() - 0.5);
  const pts = ["論理","感情","疑い深い","積極的","慎重","天然","強引"];

  const players = [{
    id:"human", name:humanName.trim()||"あなた", isHuman:true,
    role:shuffled[0], alive:true, personality:"論理",
    knownInfo:[], publishedInfo:[], suspicion:{}, illusionistUsed:false, claimedSeer:false,
  }];

  for (let i=1; i<shuffled.length; i++) {
    players.push({
      id:`ai_${i}`, name:names[(i-1)%names.length], isHuman:false,
      role:shuffled[i], alive:true, personality:pts[(i-1)%pts.length],
      knownInfo:[], publishedInfo:[], suspicion:{}, illusionistUsed:false, claimedSeer:false,
    });
  }

  return players.map(p => {
    const sus = {};
    players.forEach(q => { if(q.id!==p.id) sus[q.name]=2+Math.floor(Math.random()*3); });
    if (p.role==="WEREWOLF") {
      players.filter(q=>q.role==="WEREWOLF"&&q.id!==p.id).forEach(q=>{sus[q.name]=0;});
    }
    return {...p, suspicion:sus};
  });
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
.chat-body{flex:1;overflow-y:auto;padding:10px;min-height:0}
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
@keyframes fu{from{opacity:0;transform:translateY(3px)}to{opacity:1;transform:none}}
.mh{display:flex;align-items:baseline;gap:5px;margin-bottom:2px}
.mn{font-weight:700;font-size:.76rem}
.mn-ai{color:var(--gold)}.mn-hu{color:#77ccff}.mn-gm{color:#aa88ff}.mn-sr{color:#66ddff}
.mt{font-size:.57rem;color:var(--muted)}.mb{font-size:.82rem;line-height:1.75;color:var(--text)}
.msg-gm{background:rgba(70,30,140,.12);border-left:3px solid var(--purple);padding:5px 8px;border-radius:0 7px 7px 0}
.msg-gm .mb{color:#ccbbff;font-size:.74rem}
.msg-sr{background:rgba(0,80,120,.18);border-left:3px solid #66ddff;padding:5px 8px;border-radius:0 7px 7px 0}
.msg-sr .mb{color:#99eeff;font-size:.8rem}
.pgrid{display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:6px;margin-top:6px}
.pc{background:var(--surf2);border:1px solid var(--bdr);border-radius:8px;padding:8px;text-align:center;transition:all .14s;cursor:default}
.pc.dead{opacity:.2;filter:grayscale(1)}
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
.ic{align-items:center}.jb{justify-content:space-between}
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

  useEffect(()=>{
    const el=chatBodyRef.current; if(!el)return;
    if(el.scrollHeight-el.scrollTop-el.clientHeight<120) el.scrollTop=el.scrollHeight;
  },[chat]);

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
    const schedule=()=>{
      autoRef.current=setTimeout(()=>{
        if(phRef.current===PHASES.DAY&&!procRef.current){
          runAITurn(plRef.current,chRef.current,null);
        }
        schedule();
      },13000+Math.random()*9000);
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
      const prompt=buildSystemPrompt(ai,pl,ch,1);
      const userMsg=`自己紹介または最初の発言をしてください（1〜2文）:`;
      let text=await callGemini(prompt,userMsg);
      if(!text) text=`こんにちは、${ai.name}です。よろしくお願いします。`;
      const m=mk({type:"ai",sender:ai.name,text,isHuman:false});
      setChat(p=>[...p,m]);ch=[...ch,m];chRef.current=ch;
    }
    setThinking(false);procRef.current=false;
  }

  async function runAITurn(pl,ch,trigger){
    if(procRef.current)return;
    procRef.current=true;setThinking(true);
    const aiAlive=pl.filter(p=>!p.isHuman&&p.alive);
    if(!aiAlive.length){setThinking(false);procRef.current=false;return;}

    let speakers=[];
    if(trigger){
      const analysis=analyzeMessage(trigger.text,trigger.sender,aiAlive);
      // 名指しされたAIは必ず返答
      const named=aiAlive.filter(ai=>analysis.mentioned.some(m=>m.id===ai.id));
      // 全員への質問には全員から1〜2人が反応
      const rest=[...aiAlive.filter(ai=>!named.some(n=>n.id===ai.id))].sort(()=>Math.random()-.5);
      const reactors=rest.slice(0, analysis.toAll ? 2 : 1);
      speakers=[...named,...reactors];
    } else {
      speakers=[...aiAlive].sort(()=>Math.random()-.5).slice(0,2+Math.floor(Math.random()*2));
    }

    for(let i=0;i<speakers.length;i++){
      await wait(1000+Math.random()*1500);
      if(phRef.current!==PHASES.DAY)break;
      const ai=speakers[i];
      let text="";let isSeer=false;

      // 占い師が結果を持っていて未公開
      if(ai.role==="SEER"&&dayRef.current>=2&&ai.knownInfo?.length>0){
        const unpub=ai.knownInfo.filter(i=>!(ai.publishedInfo||[]).includes(i));
        if(unpub.length&&Math.random()>0.5){
          const sys=buildSystemPrompt(ai,pl,ch,dayRef.current);
          const um=`占い師として昨夜「${unpub[unpub.length-1]}」という結果を得ました。今このタイミングで公開する自然な発言（1〜2文）:`;
          text=await callGemini(sys,um)||`占い師として報告します。${unpub[unpub.length-1]}`;
          isSeer=true;
          const updPl=plRef.current.map(p=>p.id===ai.id?{...p,publishedInfo:[...(p.publishedInfo||[]),...ai.knownInfo],claimedSeer:true}:p);
          setPlayers(updPl);plRef.current=updPl;
        }
      }

      if(!text){
        text=await generateAISpeech(ai,pl,ch,dayRef.current,trigger);
        if(!text) text=fallbackSpeech(ai,pl,trigger,dayRef.current);
      }

      const m=mk({type:"ai",sender:ai.name,text,isHuman:false,isSeer});
      setChat(prev=>[...prev,m]);ch=[...ch,m];chRef.current=ch;
    }
    setThinking(false);procRef.current=false;
  }

  function sendChat(){
    if(!input.trim()||!myP?.alive)return;
    const txt=input.trim();setInput("");
    const m=mk({type:"human",sender:myP.name,text:txt,isHuman:true});
    setChat(p=>[...p,m]);chRef.current=[...chRef.current,m];
    setTimeout(()=>runAITurn(plRef.current,chRef.current,{sender:myP.name,text:txt}),400);
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
    if(myP?.role==="WEREWOLF"&&myP.alive)addW({type:"wolf",sender:"🐺 人狼チャット",text:"今夜は誰を狙う？仲間で相談しよう。",isHuman:false});
    const acts={};
    pl.filter(p=>!p.isHuman&&p.alive&&["WEREWOLF","SEER","KNIGHT","ILLUSIONIST","WITCH"].includes(p.role)).forEach(ai=>{
      const cands=pl.filter(q=>q.alive&&q.id!==ai.id);if(!cands.length)return;
      if(ai.role==="WEREWOLF"){
        const wolfIds=pl.filter(q=>q.role==="WEREWOLF").map(q=>q.id);
        const prio=cands.filter(q=>["SEER","KNIGHT","MEDIUM"].includes(q.role));
        const safe=cands.filter(q=>!wolfIds.includes(q.id));
        const pool=prio.length?prio:safe.length?safe:cands;
        acts[ai.id]=pool[Math.floor(Math.random()*pool.length)].id;
      }else{
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
    Object.entries(acts).forEach(([aid,tid])=>{const a=upd.find(p=>p.id===aid);if(a?.role==="KNIGHT"&&a.alive)prot.add(tid);});
    Object.entries(acts).forEach(([aid,tid])=>{const a=upd.find(p=>p.id===aid);if(a?.role==="ILLUSIONIST"&&a.alive&&!a.illusionistUsed){redir=tid;upd=upd.map(p=>p.id===aid?{...p,illusionistUsed:true}:p);}});
    const we=Object.entries(acts).filter(([aid])=>{const a=upd.find(p=>p.id===aid);return a?.role==="WEREWOLF"&&a.alive;});
    const results=[];
    if(we.length){
      const atk=redir||we[0][1];
      if(prot.has(atk)){results.push({t:"今夜は騎士が誰かを守りました！",tp:"g"});}
      else{const v=upd.find(p=>p.id===atk);if(v?.alive){upd=upd.map(p=>p.id===atk?{...p,alive:false}:p);results.push({t:`${v.name} が人狼に襲われました。`,tp:"b"});}}
    }else{results.push({t:"今夜は平和でした。",tp:"i"});}
    Object.entries(acts).forEach(([aid,tid])=>{
      const a=upd.find(p=>p.id===aid);
      if(a?.role==="SEER"&&a.alive){
        const tg=upd.find(p=>p.id===tid);
        if(tg){
          const res=tg.role==="WEREWOLF"?"人狼":"村人";
          const info=`${tg.name}を占いました。結果は${res}でした。`;
          upd=upd.map(p=>p.id===aid?{...p,knownInfo:[...(p.knownInfo||[]),info]}:p);
          if(a.isHuman)results.push({t:`🔮 占い結果: ${info}`,tp:"i"});
        }
      }
    });
    setPlayers(upd);plRef.current=upd;
    const nd=dayRef.current+1;setDay(nd);dayRef.current=nd;
    const w=checkWin(upd);
    if(w.over){setWinners(w.winners);setEndPlayers(upd);setTimeout(()=>setPhase(PHASES.GAME_OVER),1500);}
    else{
      setTimeout(()=>{
        setPhase(PHASES.DAY);phRef.current=PHASES.DAY;
        setTimerSec(DAY_SEC);setTimerOn(true);
        setMyVote(null);setAiVotes({});setSelTgt(null);voteDoneRef.current=false;
        const baker=upd.find(p=>p.role==="BAKER"&&p.alive);
        const msgs=[
          mk({type:"gm",sender:"🎲 GM",text:`☀️ 第${nd}日目の朝が始まりました。`,isHuman:false}),
          ...results.map(r=>mk({type:"gm",sender:"🎲 GM",text:r.t,isHuman:false})),
          ...(baker?[mk({type:"gm",sender:"🎲 GM",text:"🍞 どこからかパンの焼ける匂いがします。",isHuman:false})]:[]),
        ];
        setChat(p=>[...p,...msgs]);chRef.current=[...chRef.current,...msgs];
        setTimeout(()=>runAITurn(upd,chRef.current,null),1500);
      },2500);
    }
  }

  function reset(){
    setPhase(PHASES.LOBBY);setPlayers([]);setChat([]);setWChat([]);
    setDay(1);setWinners([]);setEndPlayers([]);
    setTimerOn(false);setTimerSec(DAY_SEC);setHumanName("");
    setExecInfo(null);voteDoneRef.current=false;
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
                    {myP.knownInfo?.length>0&&<div className="mri">📋 {myP.knownInfo[myP.knownInfo.length-1]}</div>}
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
              <span style={{fontSize:".76rem",marginTop:12,display:"block",color:"#ffbbbb"}}>彼/彼女の役職は…秘密です。</span>
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
                    {myP.role==="ILLUSIONIST"&&"✨ 人狼の攻撃を向ける相手を選んでください"}
                    {myP.role==="WITCH"&&"🧙 呪う相手を選んでください"}
                    {myP.role==="WEREWOLF"&&"🐺 襲撃する相手を選んでください"}
                  </div>
                  <div className="pgrid">
                    {alive.filter(p=>!p.isHuman).map(p=>(
                      <div key={p.id} className={`pc sel${selTgt===p.id?" picked":""}`} onClick={()=>setSelTgt(p.id)}>
                        <div className="pe">🤖</div><div className="pn">{p.name}</div>
                      </div>
                    ))}
                  </div>
                  <button className="btn bp mt3" disabled={!selTgt} onClick={submitNight}>決定</button>
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
                <div className="ct">全員の役職公開（ゲーム終了後のみ）</div>
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

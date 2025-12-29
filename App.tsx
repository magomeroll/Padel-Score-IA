
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality, Type } from '@google/genai';
import { 
  Team, 
  ScoreState, 
  Rule66, 
  DeuceMode,
  MatchConfig, 
  MatchHistoryEntry 
} from './types';
import { POINT_VALUES, SYSTEM_INSTRUCTION } from './constants';
import { decode, decodeAudioData, createBlob } from './services/audioManager';

const createInitialScore = (): ScoreState => ({
  points: { us: 0, them: 0 },
  games: { us: 0, them: 0 },
  sets: { us: 0, them: 0 },
  setHistory: [],
  isTieBreak: false,
  tieBreakPoints: { us: 0, them: 0 },
  deuceCount: 0,
});

const INITIAL_CONFIG: MatchConfig = {
  rule66: Rule66.TIE_BREAK,
  deuceMode: DeuceMode.IMMEDIATE_KILLER,
};

const App: React.FC = () => {
  const [score, setScore] = useState<ScoreState>(createInitialScore());
  const [config, setConfig] = useState<MatchConfig>(INITIAL_CONFIG);
  const [history, setHistory] = useState<MatchHistoryEntry[]>([]);
  const [isLive, setIsLive] = useState(false);
  const [statusMsg, setStatusMsg] = useState('Pronto');
  const [lastAction, setLastAction] = useState<string>('');
  
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem('GEMINI_API_KEY') || '');
  const [showKeyModal, setShowKeyModal] = useState<boolean>(!localStorage.getItem('GEMINI_API_KEY'));
  const [tempKey, setTempKey] = useState(apiKey);

  const saveApiKey = () => {
    localStorage.setItem('GEMINI_API_KEY', tempKey);
    setApiKey(tempKey);
    setShowKeyModal(false);
    setStatusMsg('Chiave Salvata');
  };

  const scoreRef = useRef(score);
  const configRef = useRef(config);
  const isLiveRef = useRef(false);
  
  useEffect(() => { scoreRef.current = score; }, [score]);
  useEffect(() => { configRef.current = config; }, [config]);
  useEffect(() => { isLiveRef.current = isLive; }, [isLive]);

  const nextStartTimeRef = useRef(0);
  const audioContextInRef = useRef<AudioContext | null>(null);
  const audioContextOutRef = useRef<AudioContext | null>(null);
  const outputNodeRef = useRef<GainNode | null>(null);
  const sessionRef = useRef<any>(null);

  const getScoreDescription = (s: ScoreState, cfg: MatchConfig): string => {
    if (s.isTieBreak) return `${s.tieBreakPoints.us} a ${s.tieBreakPoints.them}`;
    if (s.points.us === 3 && s.points.them === 3) {
      const isKiller = cfg.deuceMode === DeuceMode.IMMEDIATE_KILLER || s.deuceCount >= 2;
      return isKiller ? "Punto Killer!" : "Parità";
    }
    if (s.points.us === 4) return "Vantaggio Blu";
    if (s.points.them === 4) return "Vantaggio Rosso";
    return `${POINT_VALUES[s.points.us]} a ${POINT_VALUES[s.points.them]}`;
  };

  const calculateNext = (winner: Team) => {
    const current = scoreRef.current;
    const cfg = configRef.current;
    const next: ScoreState = JSON.parse(JSON.stringify(current));
    const loser = winner === 'us' ? 'them' : 'us';
    let gameWon = false;
    let msg = "";

    if (next.isTieBreak) {
      next.tieBreakPoints[winner]++;
      const pW = next.tieBreakPoints[winner];
      const pL = next.tieBreakPoints[loser];
      if (pW >= 7 && (pW - pL >= 2)) {
        gameWon = true;
        next.isTieBreak = false;
      }
    } else {
      const pW = next.points[winner];
      const pL = next.points[loser];
      if (pW === 3 && pL === 3) {
        if (cfg.deuceMode === DeuceMode.IMMEDIATE_KILLER || next.deuceCount >= 2) {
          gameWon = true;
        } else {
          next.points[winner] = 4;
        }
      } else if (pW === 4) {
        gameWon = true;
      } else if (pL === 4) {
        next.points = { us: 3, them: 3 };
        next.deuceCount++;
      } else if (pW === 3) {
        gameWon = true;
      } else {
        next.points[winner]++;
      }
    }

    if (gameWon) {
      next.points = { us: 0, them: 0 };
      next.tieBreakPoints = { us: 0, them: 0 };
      next.deuceCount = 0;
      next.games[winner]++;
      const limit = cfg.rule66 === Rule66.PRO_SET_8 ? 8 : 6;
      let setWon = false;
      
      if (next.games.us === 6 && next.games.them === 6 && cfg.rule66 === Rule66.TIE_BREAK) {
        next.isTieBreak = true;
        msg = "Tie-break!";
      } else if ((next.games[winner] >= limit && (next.games[winner] - next.games[loser] >= 2)) || 
                 (next.games.us === 7 && next.games.them === 6 && cfg.rule66 === Rule66.TIE_BREAK) || 
                 (next.games[winner] === 8 && cfg.rule66 === Rule66.PRO_SET_8)) {
        setWon = true;
      }

      if (setWon) {
        next.sets[winner]++;
        next.setHistory.push({ us: next.games.us, them: next.games.them });
        next.games = { us: 0, them: 0 };
        msg = `Set ${winner === 'us' ? 'Blu' : 'Rosso'}!`;
      } else {
        msg = `Game ${winner === 'us' ? 'Blu' : 'Rosso'}!`;
      }
    } else {
      msg = getScoreDescription(next, cfg);
    }
    return { next, msg };
  };

  const updateScore = useCallback((winner: Team): string => {
    const { next, msg } = calculateNext(winner);
    setHistory(prev => [...prev, { state: JSON.parse(JSON.stringify(scoreRef.current)), timestamp: Date.now() }]);
    setScore(next);
    setLastAction(`Punto ${winner === 'us' ? 'Blu' : 'Rosso'}`);
    return msg;
  }, []);

  const undo = useCallback(() => {
    if (history.length === 0) return "Nulla da annullare.";
    const last = history[history.length - 1];
    setScore(last.state);
    setHistory(prev => prev.slice(0, -1));
    setLastAction("Annullato");
    return "Annullato. " + getScoreDescription(last.state, configRef.current);
  }, [history]);

  const resetMatch = useCallback(() => {
    setScore(createInitialScore());
    setHistory([]);
    setLastAction("Match Resettato");
    nextStartTimeRef.current = 0;
    return "Match resettato.";
  }, []);

  const updateScoreRef = useRef(updateScore);
  const undoRef = useRef(undo);
  const resetRef = useRef(resetMatch);
  useEffect(() => { 
    updateScoreRef.current = updateScore; 
    undoRef.current = undo; 
    resetRef.current = resetMatch; 
  }, [updateScore, undo, resetMatch]);

  const startLive = async () => {
    if (!apiKey) {
      setShowKeyModal(true);
      return;
    }

    try {
      setStatusMsg('Sincronizzazione...');
      
      if (!audioContextInRef.current) {
        audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        outputNodeRef.current = audioContextOutRef.current.createGain();
        outputNodeRef.current.connect(audioContextOutRef.current.destination);
      } else {
        await audioContextInRef.current.resume();
        await audioContextOutRef.current.resume();
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("PERMISSION_DENIED");
      });

      const ai = new GoogleGenAI({ apiKey: apiKey });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          systemInstruction: SYSTEM_INSTRUCTION,
          tools: [{ functionDeclarations: [
            { name: 'addPoint', description: "Assegna punto a 'us' (blu) o 'them' (rosso)", parameters: { type: Type.OBJECT, properties: { team: { type: Type.STRING, enum: ['us', 'them'] } }, required: ['team'] } },
            { name: 'undoLastPoint', description: "Annulla ultimo", parameters: { type: Type.OBJECT, properties: {} } },
            { name: 'resetMatch', description: "Reset totale", parameters: { type: Type.OBJECT, properties: {} } }
          ]}],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } }
        },
        callbacks: {
          onopen: () => {
            setIsLive(true);
            setStatusMsg('Arbitro Attivo');
            sessionPromise.then(s => {
              const source = audioContextInRef.current!.createMediaStreamSource(stream);
              const scriptProcessor = audioContextInRef.current!.createScriptProcessor(4096, 1, 1);
              scriptProcessor.onaudioprocess = (e) => {
                if (isLiveRef.current) s.sendRealtimeInput({ media: createBlob(e.inputBuffer.getChannelData(0)) });
              };
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContextInRef.current!.destination);
            });
          },
          onmessage: async (msg: LiveServerMessage) => {
            if (msg.serverContent?.modelTurn?.parts[0]?.inlineData?.data && audioContextOutRef.current) {
              const ctx = audioContextOutRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
              const buffer = await decodeAudioData(decode(msg.serverContent.modelTurn.parts[0].inlineData.data), ctx, 24000, 1);
              const source = ctx.createBufferSource();
              source.buffer = buffer;
              source.connect(outputNodeRef.current!);
              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += buffer.duration;
            }
            if (msg.toolCall) {
              for (const fc of msg.toolCall.functionCalls) {
                let res = "";
                if (fc.name === 'addPoint') res = updateScoreRef.current(fc.args.team as Team);
                if (fc.name === 'undoLastPoint') res = undoRef.current();
                if (fc.name === 'resetMatch') res = resetRef.current();
                sessionPromise.then(s => s.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: res } } }));
              }
            }
          },
          onerror: (e) => {
            console.error(e);
            setStatusMsg('Errore API/Key');
            setIsLive(false);
          },
          onclose: () => setIsLive(false)
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err: any) {
      console.error(err);
      if (err.message === "PERMISSION_DENIED") {
        setStatusMsg('Mic Negato');
      } else {
        setStatusMsg('Errore Connessione');
      }
    }
  };

  const isKillerPoint = !score.isTieBreak && score.points.us === 3 && score.points.them === 3 && 
    (config.deuceMode === DeuceMode.IMMEDIATE_KILLER || score.deuceCount >= 2);

  return (
    <div className="h-screen w-screen bg-[#020617] text-white flex flex-col font-sans select-none overflow-hidden touch-none">
      {/* Key Modal */}
      {showKeyModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/95 backdrop-blur-xl p-6">
          <div className="bg-slate-900 border-2 border-blue-500/50 rounded-[2.5rem] w-full max-w-md p-8 shadow-2xl">
            <h2 className="text-2xl font-black italic text-blue-500 mb-2">CONFIGURA IA</h2>
            <p className="text-slate-400 text-xs mb-6">Inserisci la tua Gemini API Key. Verrà salvata solo qui.</p>
            <input 
              type="password" 
              value={tempKey} 
              onChange={(e) => setTempKey(e.target.value)}
              placeholder="Chiave API..."
              className="w-full bg-black/50 border border-slate-700 rounded-2xl p-4 text-blue-400 font-mono text-sm mb-6 outline-none"
            />
            <div className="flex gap-3">
              <button onClick={saveApiKey} className="flex-1 bg-blue-600 py-4 rounded-2xl font-black uppercase text-xs shadow-lg">Salva</button>
              {apiKey && <button onClick={() => setShowKeyModal(false)} className="px-6 bg-slate-800 py-4 rounded-2xl font-black uppercase text-xs">Esci</button>}
            </div>
          </div>
        </div>
      )}

      {/* Header compatto per Mobile */}
      <header className="px-4 py-3 flex justify-between items-center bg-slate-900/50 border-b border-white/5 backdrop-blur-md shrink-0">
        <div>
          <h1 className="text-lg font-black italic text-blue-500 leading-none">PV <span className="text-white">ULTRA</span></h1>
          <div className="flex items-center gap-1.5 mt-0.5">
            <div className={`w-1.5 h-1.5 rounded-full ${isLive ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[8px] uppercase font-black text-slate-400 tracking-tighter">{statusMsg}</span>
          </div>
        </div>
        
        <div className="flex items-center gap-2">
          {lastAction && <div className="hidden sm:block text-[9px] font-black uppercase text-blue-400/80 bg-blue-500/10 px-2 py-1 rounded-lg border border-blue-500/20">{lastAction}</div>}
          <button onClick={() => setShowKeyModal(true)} className="p-2.5 bg-slate-800/80 rounded-xl text-slate-400"><svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /></svg></button>
          <button 
            onClick={isLive ? () => { sessionRef.current?.close(); setIsLive(false); } : startLive}
            className={`px-4 py-2.5 rounded-xl font-black text-[10px] uppercase transition-all ${isLive ? 'bg-red-600 shadow-[0_3px_0_#991b1b]' : 'bg-blue-600 shadow-[0_3px_0_#1d4ed8]'} active:translate-y-0.5 active:shadow-none`}
          >
            {isLive ? 'STOP' : 'ATTIVA VOCE'}
          </button>
        </div>
      </header>

      {/* Main Score Area - Verticale su Mobile */}
      <main className="flex-1 flex flex-col md:flex-row p-2 gap-2 overflow-hidden">
        {/* Team BLU */}
        <div className="flex-1 bg-gradient-to-br from-blue-600/10 to-blue-900/30 rounded-[2.5rem] border border-blue-500/20 flex flex-col items-center justify-center relative overflow-hidden group">
          <span className="absolute top-4 left-6 text-blue-500/30 font-black text-xl tracking-[0.5em] uppercase pointer-events-none">BLU</span>
          <div className="score-font text-[8rem] sm:text-[10rem] md:text-[15rem] font-black leading-none text-blue-500 drop-shadow-[0_0_30px_rgba(59,130,246,0.4)] score-change">
            {score.isTieBreak ? score.tieBreakPoints.us : (score.points.us === 4 ? 'AD' : POINT_VALUES[score.points.us])}
          </div>
          {isKillerPoint && <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 rotate-[-10deg] bg-yellow-500 text-black px-6 py-2 rounded-lg font-black text-xl uppercase border-2 border-black z-10 pointer-events-none animate-pulse">KILLER</div>}
          {!isKillerPoint && score.points.us === 4 && <div className="mt-[-1rem] bg-blue-500 text-white px-4 py-1 rounded-full font-black text-[10px] uppercase">VANTAGGIO</div>}
          {/* Hitbox per manual override se necessario */}
          <div className="absolute inset-0 z-0" onClick={() => updateScore('us')}></div>
        </div>

        {/* Team ROSSO */}
        <div className="flex-1 bg-gradient-to-br from-red-600/10 to-red-900/30 rounded-[2.5rem] border border-red-500/20 flex flex-col items-center justify-center relative overflow-hidden group">
          <span className="absolute top-4 left-6 text-red-500/30 font-black text-xl tracking-[0.5em] uppercase pointer-events-none">ROSSO</span>
          <div className="score-font text-[8rem] sm:text-[10rem] md:text-[15rem] font-black leading-none text-red-500 drop-shadow-[0_0_30px_rgba(239,68,68,0.4)] score-change">
            {score.isTieBreak ? score.tieBreakPoints.them : (score.points.them === 4 ? 'AD' : POINT_VALUES[score.points.them])}
          </div>
          {!isKillerPoint && score.points.them === 4 && <div className="mt-[-1rem] bg-red-500 text-white px-4 py-1 rounded-full font-black text-[10px] uppercase">VANTAGGIO</div>}
          <div className="absolute inset-0 z-0" onClick={() => updateScore('them')}></div>
        </div>
      </main>

      {/* Footer ultra-compatto */}
      <footer className="bg-slate-900 p-3 flex flex-col gap-2 border-t border-white/5 shrink-0">
        <div className="flex items-stretch gap-2 h-16">
          <div className="flex-1 bg-black/40 rounded-2xl flex items-center justify-around border border-white/5">
            <div className="text-center">
              <span className="text-[7px] text-slate-500 font-black uppercase tracking-tighter block">GIOCHI</span>
              <span className="text-2xl font-black leading-none text-blue-400">{score.games.us}<span className="text-slate-700 mx-1">/</span><span className="text-red-400">{score.games.them}</span></span>
            </div>
            <div className="w-[1px] h-6 bg-white/5"></div>
            <div className="text-center">
              <span className="text-[7px] text-slate-500 font-black uppercase tracking-tighter block">SET</span>
              <span className="text-2xl font-black leading-none text-blue-400">{score.sets.us}<span className="text-slate-700 mx-1">/</span><span className="text-red-400">{score.sets.them}</span></span>
            </div>
          </div>
          
          <div className="flex-1 bg-black/40 rounded-2xl flex flex-wrap items-center justify-center gap-1.5 p-2 border border-white/5">
            {score.setHistory.length > 0 ? score.setHistory.map((s, i) => (
              <span key={i} className="text-[10px] font-black bg-slate-800 px-2 py-1 rounded-lg text-slate-300 border border-white/5">{s.us}-{s.them}</span>
            )) : <span className="text-[9px] text-slate-600 font-black italic uppercase">In Corso...</span>}
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-[2] grid grid-cols-2 gap-2">
            <select value={config.rule66} onChange={(e) => setConfig(p => ({...p, rule66: e.target.value as Rule66}))} className="bg-slate-800 text-[9px] font-black p-3 rounded-xl outline-none border border-white/5 uppercase tracking-tighter text-blue-400 appearance-none text-center">
              <option value={Rule66.TIE_BREAK}>6-6 Tie</option>
              <option value={Rule66.PRO_SET_8}>8-Game</option>
            </select>
            <select value={config.deuceMode} onChange={(e) => setConfig(p => ({...p, deuceMode: e.target.value as DeuceMode}))} className="bg-slate-800 text-[9px] font-black p-3 rounded-xl outline-none border border-white/5 uppercase tracking-tighter text-yellow-500 appearance-none text-center">
              <option value={DeuceMode.IMMEDIATE_KILLER}>Killer Subito</option>
              <option value={DeuceMode.ADV_X2_THEN_KILLER}>Vantaggi x2</option>
            </select>
          </div>
          <div className="flex-1 flex gap-2">
            <button onClick={() => undo()} disabled={history.length === 0} className={`flex-1 rounded-xl flex items-center justify-center ${history.length === 0 ? 'bg-slate-800/50 text-slate-700' : 'bg-orange-500 text-white shadow-lg'}`}>
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" /></svg>
            </button>
            <button onClick={() => { if(window.confirm("Reset?")) resetMatch(); }} className="flex-1 bg-red-600/20 text-red-500 border border-red-500/30 rounded-xl flex items-center justify-center">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;

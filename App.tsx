
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
    try {
      setStatusMsg('Sincronizzazione...');
      
      // Riattiva o crea gli AudioContext
      if (!audioContextInRef.current) {
        audioContextInRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        audioContextOutRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        outputNodeRef.current = audioContextOutRef.current.createGain();
        outputNodeRef.current.connect(audioContextOutRef.current.destination);
      } else {
        await audioContextInRef.current.resume();
        await audioContextOutRef.current.resume();
      }

      if (!process.env.API_KEY) {
        setStatusMsg('Configura API Key');
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => {
        throw new Error("PERMISSION_DENIED");
      });

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
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
            setStatusMsg('Errore API');
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
    <div className="min-h-screen bg-[#020617] text-white flex flex-col font-sans select-none overflow-hidden">
      <header className="p-4 flex justify-between items-center bg-slate-900/80 border-b border-slate-800 backdrop-blur-md z-10 shadow-lg">
        <div className="flex flex-col">
          <h1 className="text-2xl font-black italic text-blue-500 tracking-tighter leading-none">PADEL VOICE <span className="text-white">ULTRA</span></h1>
          <div className="flex items-center gap-2 mt-1">
            <div className={`w-2 h-2 rounded-full ${isLive ? 'bg-green-500 animate-pulse' : 'bg-red-500'}`} />
            <span className="text-[10px] uppercase font-black text-slate-400 tracking-widest">{statusMsg}</span>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {lastAction && (
            <div className="hidden md:block bg-blue-500/10 border border-blue-500/30 px-4 py-2 rounded-xl text-[10px] font-black uppercase text-blue-400 animate-fade-in">
              {lastAction}
            </div>
          )}
          <button 
            onClick={isLive ? () => { sessionRef.current?.close(); setIsLive(false); } : startLive}
            className={`px-8 py-4 rounded-2xl font-black text-xs uppercase transition-all shadow-[0_6px_0_#1d4ed8] ${isLive ? 'bg-red-600 shadow-[0_6px_0_#991b1b]' : 'bg-blue-600'} active:translate-y-1 active:shadow-none hover:scale-105`}
          >
            {isLive ? 'CHIUDI SESSIONE' : '🎤 ENTRA IN CAMPO'}
          </button>
        </div>
      </header>

      <main className="flex-1 grid grid-cols-1 md:grid-cols-2 p-4 gap-6">
        <div className="bg-gradient-to-br from-blue-600/20 to-blue-900/40 rounded-[4rem] border-2 border-blue-500/30 flex flex-col items-center justify-center relative shadow-2xl overflow-hidden">
          <span className="absolute top-10 text-blue-400 font-black text-3xl uppercase tracking-[1.5em] opacity-30">BLU</span>
          <span className="score-font text-[18rem] md:text-[25rem] font-black leading-none text-blue-500 drop-shadow-[0_0_40px_rgba(59,130,246,0.5)]">
            {score.isTieBreak ? score.tieBreakPoints.us : (score.points.us === 4 ? 'AD' : POINT_VALUES[score.points.us])}
          </span>
          {isKillerPoint && <div className="absolute bottom-12 bg-yellow-500 text-black px-12 py-4 rounded-full font-black text-3xl uppercase animate-bounce border-4 border-black z-10">KILLER POINT</div>}
          {!isKillerPoint && score.points.us === 4 && <div className="absolute bottom-12 bg-blue-500 text-white px-10 py-3 rounded-full font-black text-2xl uppercase">VANTAGGIO</div>}
        </div>

        <div className="bg-gradient-to-br from-red-600/20 to-red-900/40 rounded-[4rem] border-2 border-red-500/30 flex flex-col items-center justify-center relative shadow-2xl overflow-hidden">
          <span className="absolute top-10 text-red-400 font-black text-3xl uppercase tracking-[1.5em] opacity-30">ROSSO</span>
          <span className="score-font text-[18rem] md:text-[25rem] font-black leading-none text-red-500 drop-shadow-[0_0_40px_rgba(239,68,68,0.5)]">
            {score.isTieBreak ? score.tieBreakPoints.them : (score.points.them === 4 ? 'AD' : POINT_VALUES[score.points.them])}
          </span>
          {!isKillerPoint && score.points.them === 4 && <div className="absolute bottom-12 bg-red-500 text-white px-10 py-3 rounded-full font-black text-2xl uppercase">VANTAGGIO</div>}
        </div>
      </main>

      <footer className="p-6 grid grid-cols-1 lg:grid-cols-3 gap-6 bg-slate-900 border-t border-slate-800 shadow-2xl z-20">
        <div className="bg-black/50 p-6 rounded-[2.5rem] flex items-center justify-around border border-slate-700">
          <div className="text-center">
            <p className="text-[12px] text-slate-500 font-black uppercase mb-2 tracking-widest text-center">GIOCHI</p>
            <div className="text-6xl font-black flex gap-4 text-blue-400 justify-center leading-none">
              {score.games.us}<span className="text-slate-800">/</span><span className="text-red-400">{score.games.them}</span>
            </div>
          </div>
          <div className="w-px h-16 bg-slate-800 mx-4" />
          <div className="text-center">
            <p className="text-[12px] text-slate-500 font-black uppercase mb-2 tracking-widest text-center">SET</p>
            <div className="text-6xl font-black flex gap-4 text-blue-400 justify-center leading-none">
              {score.sets.us}<span className="text-slate-800">/</span><span className="text-red-400">{score.sets.them}</span>
            </div>
          </div>
        </div>

        <div className="bg-black/50 p-6 rounded-[2.5rem] flex flex-col justify-center border border-slate-700">
          <p className="text-[12px] text-slate-500 font-black uppercase mb-3 text-center tracking-widest">SET PRECEDENTI</p>
          <div className="flex justify-center gap-3">
            {score.setHistory.map((s, i) => (
              <span key={i} className="bg-slate-800 px-5 py-2 rounded-2xl text-xl font-black text-slate-300 border border-slate-600 shadow-lg">
                {s.us}-{s.them}
              </span>
            ))}
            {score.setHistory.length === 0 && <span className="text-slate-600 text-sm font-bold italic uppercase tracking-widest">In Corso</span>}
          </div>
        </div>

        <div className="bg-black/50 p-6 rounded-[2.5rem] border border-slate-700 flex flex-col gap-4 shadow-inner">
          <div className="flex flex-col gap-2">
            <select value={config.rule66} onChange={(e) => setConfig(p => ({...p, rule66: e.target.value as Rule66}))} className="w-full bg-slate-900 text-blue-400 p-3 rounded-xl text-[11px] font-black outline-none border border-slate-700 appearance-none text-center uppercase tracking-widest cursor-pointer">
              <option value={Rule66.TIE_BREAK}>Tie-Break al 6-6</option>
              <option value={Rule66.PRO_SET_8}>Pro-Set (8 game)</option>
            </select>
            <select value={config.deuceMode} onChange={(e) => setConfig(p => ({...p, deuceMode: e.target.value as DeuceMode}))} className="w-full bg-slate-900 text-yellow-500 p-3 rounded-xl text-[11px] font-black outline-none border border-slate-700 appearance-none text-center uppercase tracking-widest cursor-pointer">
              <option value={DeuceMode.IMMEDIATE_KILLER}>Punto Killer subito</option>
              <option value={DeuceMode.ADV_X2_THEN_KILLER}>Vantaggi x2 poi Killer</option>
            </select>
          </div>
          <div className="flex gap-4">
            <button onClick={() => undo()} disabled={history.length === 0} className={`flex-1 py-4 rounded-2xl font-black uppercase text-xs transition-all ${history.length === 0 ? 'bg-slate-800 text-slate-600 cursor-not-allowed' : 'bg-orange-600/20 text-orange-500 border border-orange-500/50 hover:bg-orange-500 hover:text-white'}`}>Annulla</button>
            <button onClick={() => { if(window.confirm("Resettare il match?")) resetMatch(); }} className="flex-1 bg-red-600/10 text-red-500 border border-red-500/30 py-4 rounded-2xl font-black uppercase text-xs hover:bg-red-600 hover:text-white transition-all shadow-lg">Reset Match</button>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;

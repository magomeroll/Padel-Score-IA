
export type Team = 'us' | 'them';

export type PointValue = '0' | '15' | '30' | '40' | 'Adv' | 'Game';

export interface ScoreState {
  points: { us: number; them: number }; // 0=0, 1=15, 2=30, 3=40, 4=Adv
  games: { us: number; them: number };
  sets: { us: number; them: number };
  setHistory: Array<{ us: number; them: number }>;
  isTieBreak: boolean;
  tieBreakPoints: { us: number; them: number };
  deuceCount: number; // Conta quante volte siamo tornati in parità nel game corrente
}

export enum Rule66 {
  TIE_BREAK = 'TIE_BREAK', // Tie-break a 7 punti
  PRO_SET_8 = 'PRO_SET_8'   // Continua fino a 8 game
}

export enum DeuceMode {
  IMMEDIATE_KILLER = 'IMMEDIATE_KILLER',
  ADV_X2_THEN_KILLER = 'ADV_X2_THEN_KILLER'
}

export interface MatchConfig {
  rule66: Rule66;
  deuceMode: DeuceMode;
}

export interface MatchHistoryEntry {
  state: ScoreState;
  timestamp: number;
}

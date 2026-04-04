import type { PlayerGameView, Suit } from './types';

export type ClientMessage =
  | { type: 'join'; name: string }
  | { type: 'bid'; bidNum: number }
  | { type: 'pass' }
  | { type: 'selectPartner'; card: string }
  | { type: 'playCard'; card: string }
  | { type: 'playAgain' }
  | { type: 'watchSeat'; seat: number }
  | { type: 'addBot' }
  | { type: 'removeBot' }
  | { type: 'kickPlayer'; seat: number }
  | { type: 'startGame' };

export type ServerMessage =
  | { type: 'state'; state: PlayerGameView }
  | { type: 'error'; message: string }
  | { type: 'joined'; playerName: string; seat: number; playerCount: number }
  | { type: 'gameStart'; turn: number }
  | { type: 'bidMade'; seat: number; bidNum: number; name: string }
  | { type: 'passed'; seat: number; name: string }
  | { type: 'bidWon'; seat: number; bidNum: number; setsNeeded: number; name: string }
  | { type: 'allPassed' }
  | { type: 'partnerSelected'; card: string }
  | { type: 'youArePartner'; bidderName: string }
  | { type: 'playPhaseStart'; turn: number; firstPlayerName: string }
  | { type: 'cardPlayed'; seat: number; card: string; nextTurn: number }
  | { type: 'trickWon'; winnerSeat: number; sets: number[]; nextTurn: number; winnerName: string; trickCards: (string | null)[] }
  | { type: 'gameOver'; bidderWon: boolean; winnerNames: string[] }
  | { type: 'playerDisconnected'; seat: number; name: string }
  | { type: 'playerReconnected'; seat: number; name: string }
  | { type: 'kicked'; reason: string }
  | { type: 'playerKicked'; seat: number; name: string };

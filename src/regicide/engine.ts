// Pure Regicide rules engine (co-op, 1–4 players). No Cloudflare dependencies.
//
// Card codes: rank + suit letter, e.g. 'AH', '7S', '10D', 'KC'. Jesters are 'X1' / 'X2'.
// Piles are arrays with index 0 = top of the pile.

export type Suit = 'H' | 'D' | 'C' | 'S';
export const SUITS: Suit[] = ['H', 'D', 'C', 'S'];

export type Phase = 'play' | 'discard' | 'jester' | 'won' | 'lost';

export interface PlayRecord {
  seat: number;
  cards: string[];
  value: number;
  damage: number;
}

export type LogEntry = { seq: number } & (
  | { t: 'play'; seat: number; cards: string[]; value: number; damage: number; heal: number; draw: number; shield: number; doubled: boolean; immune: Suit[] }
  | { t: 'jester'; seat: number }
  | { t: 'yield'; seat: number }
  | { t: 'damage'; seat: number; amount: number }
  | { t: 'nodamage'; seat: number }
  | { t: 'discard'; seat: number; cards: string[]; value: number }
  | { t: 'defeat'; seat: number; enemy: string; exact: boolean }
  | { t: 'reveal'; enemy: string }
  | { t: 'choose'; seat: number; target: number }
  | { t: 'flip'; seat: number; drawn: number }
  | { t: 'won' }
  | { t: 'lost'; seat: number; reason: string }
);
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type LogInput = DistributiveOmit<LogEntry, 'seq'>;

export interface RegicideGame {
  numPlayers: number;
  maxHand: number;
  hands: string[][];
  tavern: string[];
  discard: string[];
  castle: string[];
  enemy: string | null;
  enemyDamage: number;
  played: PlayRecord[];
  jesterActive: boolean;
  currentSeat: number;
  phase: Phase;
  pendingDamage: number;
  /** Whether each seat's most recent turn was a yield (the yield rule looks at every other player's last turn). */
  lastTurnYielded: boolean[];
  soloJestersLeft: number;
  defeated: string[];
  log: LogEntry[];
  seq: number;
  loseReason: string | null;
}

export type Rng = () => number;

const MAX_HAND: Record<number, number> = { 1: 8, 2: 7, 3: 6, 4: 5 };
const JESTERS: Record<number, number> = { 1: 0, 2: 0, 3: 1, 4: 2 };
const NUMBER_RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
export const ROYAL_STATS: Record<string, { attack: number; health: number }> = {
  J: { attack: 10, health: 20 },
  Q: { attack: 15, health: 30 },
  K: { attack: 20, health: 40 },
};
const LOG_LIMIT = 60;

export function isJester(card: string): boolean {
  return card.startsWith('X');
}

export function cardRank(card: string): string {
  return isJester(card) ? 'X' : card.slice(0, -1);
}

export function cardSuit(card: string): Suit | null {
  return isJester(card) ? null : (card.slice(-1) as Suit);
}

export function cardValue(card: string): number {
  const rank = cardRank(card);
  if (rank === 'X') return 0;
  if (rank === 'A') return 1;
  if (rank in ROYAL_STATS) return ROYAL_STATS[rank].attack;
  return Number(rank);
}

export function handValue(cards: string[]): number {
  return cards.reduce((sum, c) => sum + cardValue(c), 0);
}

export function shuffle<T>(arr: T[], rng: Rng = Math.random): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function newGame(numPlayers: number, rng: Rng = Math.random, startSeat?: number): RegicideGame {
  if (!(numPlayers in MAX_HAND)) throw new Error('Regicide supports 1–4 players');
  const royals = (rank: string) => shuffle(SUITS.map((s) => rank + s), rng);
  const castle = [...royals('J'), ...royals('Q'), ...royals('K')];
  const tavern: string[] = [];
  for (const s of SUITS) for (const r of NUMBER_RANKS) tavern.push(r + s);
  for (let i = 1; i <= JESTERS[numPlayers]; i++) tavern.push(`X${i}`);
  shuffle(tavern, rng);

  const maxHand = MAX_HAND[numPlayers];
  const hands: string[][] = Array.from({ length: numPlayers }, () => []);
  for (let i = 0; i < maxHand; i++) for (const hand of hands) hand.push(tavern.shift()!);

  const game: RegicideGame = {
    numPlayers,
    maxHand,
    hands,
    tavern,
    discard: [],
    castle,
    enemy: null,
    enemyDamage: 0,
    played: [],
    jesterActive: false,
    currentSeat: startSeat ?? Math.floor(rng() * numPlayers),
    phase: 'play',
    pendingDamage: 0,
    lastTurnYielded: Array(numPlayers).fill(false),
    soloJestersLeft: numPlayers === 1 ? 2 : 0,
    defeated: [],
    log: [],
    seq: 0,
    loseReason: null,
  };
  revealNext(game);
  return game;
}

function addLog(game: RegicideGame, entry: LogInput): void {
  game.log.push({ ...entry, seq: ++game.seq } as LogEntry);
  if (game.log.length > LOG_LIMIT) game.log.splice(0, game.log.length - LOG_LIMIT);
}

export function enemyStats(game: RegicideGame): { attack: number; health: number; suit: Suit } | null {
  if (!game.enemy) return null;
  const stats = ROYAL_STATS[cardRank(game.enemy)];
  return { ...stats, suit: cardSuit(game.enemy)! };
}

/** Whether the current enemy ignores this suit's power. */
export function isImmune(game: RegicideGame, suit: Suit): boolean {
  return !game.jesterActive && !!game.enemy && cardSuit(game.enemy) === suit;
}

/** Total spade shield against the current enemy. Spades played before a Jester start counting once it lands. */
export function shieldValue(game: RegicideGame): number {
  if (!game.enemy || isImmune(game, 'S')) return 0;
  return game.played
    .filter((p) => p.cards.some((c) => cardSuit(c) === 'S'))
    .reduce((sum, p) => sum + p.value, 0);
}

export function currentAttack(game: RegicideGame): number {
  const stats = enemyStats(game);
  return stats ? Math.max(0, stats.attack - shieldValue(game)) : 0;
}

/**
 * "A player may not yield if every other player has yielded on their last turn."
 * Solo players may never yield (as in the official Board Game Arena adaptation).
 */
export function canYield(game: RegicideGame, seat = game.currentSeat): boolean {
  if (game.numPlayers === 1) return false;
  const yielded = game.lastTurnYielded ?? [];
  return !game.hands.every((_, s) => s === seat || yielded[s]);
}

/** Returns an error message, or null when the cards form a legal attack. */
export function validatePlay(cards: string[]): string | null {
  if (cards.length === 0) return 'Select a card to play';
  if (new Set(cards).size !== cards.length) return 'Duplicate card';
  if (cards.some(isJester)) return cards.length === 1 ? null : 'The Jester must be played alone';
  if (cards.length === 1) return null;
  const ranks = cards.map(cardRank);
  const aces = ranks.filter((r) => r === 'A').length;
  if (aces > 0) {
    return cards.length === 2 ? null : 'An Animal Companion (A) pairs with just one other card';
  }
  if (new Set(ranks).size !== 1) return 'Combos must be cards of the same rank';
  if (handValue(cards) > 10) return 'Combos must total 10 or less';
  return null;
}

function markTurn(game: RegicideGame, seat: number, yielded: boolean): void {
  game.lastTurnYielded ??= Array(game.numPlayers).fill(false);
  game.lastTurnYielded[seat] = yielded;
}

function removeFromHand(hand: string[], cards: string[]): boolean {
  if (new Set(cards).size !== cards.length) return false;
  if (!cards.every((c) => hand.includes(c))) return false;
  for (const c of cards) hand.splice(hand.indexOf(c), 1);
  return true;
}

function heal(game: RegicideGame, amount: number, rng: Rng): number {
  shuffle(game.discard, rng);
  const moved = game.discard.splice(0, Math.min(amount, game.discard.length));
  game.tavern.push(...moved);
  return moved.length;
}

function drawRoundRobin(game: RegicideGame, fromSeat: number, amount: number): number {
  let drawn = 0;
  let seat = fromSeat;
  while (drawn < amount && game.tavern.length > 0) {
    if (game.hands.every((h) => h.length >= game.maxHand)) break;
    if (game.hands[seat].length < game.maxHand) {
      game.hands[seat].push(game.tavern.shift()!);
      drawn++;
    }
    seat = (seat + 1) % game.numPlayers;
  }
  return drawn;
}

function revealNext(game: RegicideGame): void {
  game.enemy = game.castle.shift() ?? null;
  game.enemyDamage = 0;
  game.played = [];
  game.jesterActive = false;
  if (game.enemy) {
    addLog(game, { t: 'reveal', enemy: game.enemy });
  } else {
    game.phase = 'won';
    addLog(game, { t: 'won' });
  }
}

function lose(game: RegicideGame, seat: number, reason: string): void {
  game.phase = 'lost';
  game.loseReason = reason;
  game.pendingDamage = 0;
  addLog(game, { t: 'lost', seat, reason });
}

/** Lose immediately if the player to act has no way to act. */
function checkCanAct(game: RegicideGame): void {
  const seat = game.currentSeat;
  if (game.phase !== 'play') return;
  if (game.hands[seat].length > 0 || canYield(game) || game.soloJestersLeft > 0) return;
  lose(game, seat, 'had no cards to play and could not yield');
}

function startNextTurn(game: RegicideGame, seat: number): void {
  game.currentSeat = seat;
  game.phase = 'play';
  game.pendingDamage = 0;
  checkCanAct(game);
}

function sufferDamage(game: RegicideGame, seat: number): void {
  const attack = currentAttack(game);
  if (attack <= 0) {
    addLog(game, { t: 'nodamage', seat });
    startNextTurn(game, (seat + 1) % game.numPlayers);
    return;
  }
  addLog(game, { t: 'damage', seat, amount: attack });
  if (handValue(game.hands[seat]) < attack && game.soloJestersLeft === 0) {
    lose(game, seat, `could not survive ${attack} damage`);
    return;
  }
  game.phase = 'discard';
  game.pendingDamage = attack;
}

function guardTurn(game: RegicideGame, seat: number, phase: Phase): string | null {
  if (game.phase === 'won' || game.phase === 'lost') return 'The game is over';
  if (seat !== game.currentSeat) return "It's not your turn";
  if (game.phase !== phase) return 'That move is not allowed right now';
  return null;
}

export function playCards(game: RegicideGame, seat: number, cards: string[], rng: Rng = Math.random): string | null {
  const err = guardTurn(game, seat, 'play') ?? validatePlay(cards);
  if (err) return err;
  if (!removeFromHand(game.hands[seat], cards)) return "You don't hold those cards";
  markTurn(game, seat, false);

  if (isJester(cards[0])) {
    game.jesterActive = true;
    game.played.push({ seat, cards, value: 0, damage: 0 });
    addLog(game, { t: 'jester', seat });
    game.phase = 'jester';
    return null;
  }

  const value = handValue(cards);
  const suits = new Set(cards.map((c) => cardSuit(c)!));
  const immune = [...suits].filter((s) => isImmune(game, s));
  const active = (s: Suit) => suits.has(s) && !immune.includes(s);
  // Hearts always resolves before Diamonds.
  const healed = active('H') ? heal(game, value, rng) : 0;
  const drawn = active('D') ? drawRoundRobin(game, seat, value) : 0;
  const doubled = active('C');
  const damage = doubled ? value * 2 : value;

  game.enemyDamage += damage;
  game.played.push({ seat, cards, value, damage });
  addLog(game, {
    t: 'play', seat, cards, value, damage, heal: healed, draw: drawn,
    shield: active('S') ? value : 0, doubled, immune,
  });

  const stats = enemyStats(game)!;
  if (game.enemyDamage >= stats.health) {
    const exact = game.enemyDamage === stats.health;
    const enemy = game.enemy!;
    game.discard.push(...game.played.flatMap((p) => p.cards));
    if (exact) game.tavern.unshift(enemy);
    else game.discard.push(enemy);
    game.defeated.push(enemy);
    addLog(game, { t: 'defeat', seat, enemy, exact });
    revealNext(game);
    // The player who defeated the enemy skips suffering damage and goes again.
    if (game.phase !== 'won') startNextTurn(game, seat);
    return null;
  }

  sufferDamage(game, seat);
  return null;
}

export function yieldTurn(game: RegicideGame, seat: number): string | null {
  const err = guardTurn(game, seat, 'play');
  if (err) return err;
  if (game.numPlayers === 1) return "You can't yield in solo play";
  if (!canYield(game)) return "You can't yield — everyone else yielded on their last turn";
  markTurn(game, seat, true);
  addLog(game, { t: 'yield', seat });
  sufferDamage(game, seat);
  return null;
}

export function discardCards(game: RegicideGame, seat: number, cards: string[]): string | null {
  const err = guardTurn(game, seat, 'discard');
  if (err) return err;
  if (cards.length === 0) return 'Select cards to discard';
  const value = cards.every((c) => game.hands[seat].includes(c)) ? handValue(cards) : -1;
  if (value < 0) return "You don't hold those cards";
  if (value < game.pendingDamage) return `Discard at least ${game.pendingDamage} (selected ${value})`;
  removeFromHand(game.hands[seat], cards);
  game.discard.push(...cards);
  addLog(game, { t: 'discard', seat, cards, value });
  startNextTurn(game, (seat + 1) % game.numPlayers);
  return null;
}

export function chooseNextPlayer(game: RegicideGame, seat: number, target: number): string | null {
  const err = guardTurn(game, seat, 'jester');
  if (err) return err;
  if (!Number.isInteger(target) || target < 0 || target >= game.numPlayers) return 'Invalid player';
  addLog(game, { t: 'choose', seat, target });
  startNextTurn(game, target);
  return null;
}

/** Solo only: discard your hand and refill to 8. Allowed before playing (step 1) or before discarding (step 4). */
export function flipSoloJester(game: RegicideGame, seat: number): string | null {
  if (game.numPlayers !== 1) return 'Jester flips are a solo-mode power';
  if (game.phase !== 'play' && game.phase !== 'discard') return guardTurn(game, seat, 'play');
  if (seat !== game.currentSeat) return "It's not your turn";
  if (game.soloJestersLeft <= 0) return 'No Jesters left';
  game.soloJestersLeft--;
  const hand = game.hands[seat];
  game.discard.push(...hand.splice(0));
  const drawn = Math.min(game.maxHand, game.tavern.length);
  hand.push(...game.tavern.splice(0, drawn));
  addLog(game, { t: 'flip', seat, drawn });
  if (game.phase === 'discard' && handValue(hand) < game.pendingDamage && game.soloJestersLeft === 0) {
    lose(game, seat, `could not survive ${game.pendingDamage} damage`);
  } else {
    checkCanAct(game);
  }
  return null;
}

/** Solo victory medal: gold (no Jesters used), silver (1), bronze (2). */
export function soloTier(game: RegicideGame): 'gold' | 'silver' | 'bronze' | null {
  if (game.numPlayers !== 1 || game.phase !== 'won') return null;
  return (['bronze', 'silver', 'gold'] as const)[game.soloJestersLeft];
}

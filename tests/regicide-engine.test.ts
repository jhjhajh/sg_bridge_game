import { describe, it, expect } from 'vitest';
import {
  newGame, playCards, yieldTurn, discardCards, chooseNextPlayer, flipSoloJester,
  validatePlay, cardValue, shieldValue, currentAttack, canYield, soloTier, handValue,
  type RegicideGame,
} from '../src/regicide/engine';

// Deterministic RNG so setups are reproducible.
function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

/** Build a game and then override the parts a test cares about. */
function setup(numPlayers: number, patch: Partial<RegicideGame> = {}): RegicideGame {
  const game = newGame(numPlayers, seeded(), 0);
  return Object.assign(game, patch);
}

describe('setup', () => {
  it.each([[1, 8, 0], [2, 7, 0], [3, 6, 1], [4, 5, 2]])('%i players: hand %i, %i jesters', (n, hand, jesters) => {
    const game = newGame(n, seeded(n));
    expect(game.hands).toHaveLength(n);
    for (const h of game.hands) expect(h).toHaveLength(hand);
    const all = [...game.tavern, ...game.hands.flat()];
    expect(all).toHaveLength(40 + jesters);
    expect(all.filter((c) => c.startsWith('X'))).toHaveLength(jesters);
    expect(game.soloJestersLeft).toBe(n === 1 ? 2 : 0);
  });

  it('orders the castle Jacks → Queens → Kings', () => {
    const game = newGame(2, seeded(7));
    expect(game.enemy![0]).toBe('J');
    expect(game.castle.slice(0, 3).every((c) => c[0] === 'J')).toBe(true);
    expect(game.castle.slice(3, 7).every((c) => c[0] === 'Q')).toBe(true);
    expect(game.castle.slice(7).every((c) => c[0] === 'K')).toBe(true);
  });
});

describe('validatePlay', () => {
  it('accepts singles, companion pairs and small sets', () => {
    expect(validatePlay(['7H'])).toBeNull();
    expect(validatePlay(['AH', '9S'])).toBeNull();
    expect(validatePlay(['AH', 'AS'])).toBeNull();
    expect(validatePlay(['AH', 'KS'])).toBeNull();
    expect(validatePlay(['5H', '5S'])).toBeNull();
    expect(validatePlay(['3H', '3S', '3D'])).toBeNull();
    expect(validatePlay(['2H', '2S', '2D', '2C'])).toBeNull();
    expect(validatePlay(['X1'])).toBeNull();
  });

  it('rejects illegal combos', () => {
    expect(validatePlay([])).not.toBeNull();
    expect(validatePlay(['6H', '6S'])).toMatch(/10 or less/);
    expect(validatePlay(['4H', '5S'])).toMatch(/same rank/);
    expect(validatePlay(['AH', '2S', '2D'])).toMatch(/one other card/);
    expect(validatePlay(['X1', '5S'])).toMatch(/alone/);
  });

  it('values cards', () => {
    expect(['AH', '7S', 'JC', 'QD', 'KH', 'X1'].map(cardValue)).toEqual([1, 7, 10, 15, 20, 0]);
  });
});

describe('suit powers', () => {
  it('clubs double damage, spades shield, enemy immune to own suit', () => {
    const game = setup(2, { enemy: 'JS', hands: [['5C', 'KS', '2D'], ['3H']] });
    expect(playCards(game, 0, ['5C'])).toBeNull();
    expect(game.enemyDamage).toBe(10);
    expect(game.phase).toBe('discard');
    expect(game.pendingDamage).toBe(10);
    expect(discardCards(game, 0, ['2D'])).toMatch(/at least 10/);

    const g2 = setup(2, { enemy: 'JS', hands: [['6S', '9D', '5H'], ['3H']] });
    playCards(g2, 0, ['6S']);
    expect(shieldValue(g2)).toBe(0); // immune
    expect(g2.pendingDamage).toBe(10);
  });

  it('spades played before a Jester start shielding once it lands', () => {
    const game = setup(3, { enemy: 'JS', hands: [['6S', 'KD'], ['X1', '2H'], ['5D', '3C']] });
    playCards(game, 0, ['6S']);
    discardCards(game, 0, ['KD']);
    expect(currentAttack(game)).toBe(10);
    playCards(game, 1, ['X1']);
    expect(game.phase).toBe('jester');
    expect(currentAttack(game)).toBe(4);
    expect(chooseNextPlayer(game, 1, 0)).toBeNull();
    expect(game.currentSeat).toBe(0);
    expect(game.phase).toBe('play');
  });

  it('hearts heal from discard to the bottom of the tavern before diamonds draw', () => {
    const game = setup(2, {
      enemy: 'JC', tavern: ['8S'], discard: ['2C', '3C', '4C'],
      hands: [['AH', '2D', 'KS'], ['5S']],
    });
    playCards(game, 0, ['AH', '2D']);
    // Healed 3 (whole discard) under the tavern, then drew 3 round-robin from the top.
    expect(game.discard).toHaveLength(0);
    expect(game.hands[0]).toContain('8S');
    expect(game.hands[0].length + game.hands[1].length).toBe(1 + 1 + 3);
    expect(game.tavern).toHaveLength(1);
  });

  it('diamonds never overfill a hand', () => {
    const game = setup(2, { enemy: 'JC', maxHand: 2, tavern: ['2S', '3S', '4S', '5S'], hands: [['9D', 'KS'], ['5H', '6H']] });
    playCards(game, 0, ['9D']);
    expect(game.hands[0]).toHaveLength(2);
    expect(game.hands[1]).toHaveLength(2);
    expect(game.tavern).toHaveLength(3);
  });
});

describe('rulebook worked examples', () => {
  it('3♦ 3♠ 3♣ together: draw 9, shield 9, deal 18', () => {
    const tavern = Array.from({ length: 12 }, (_, i) => `${(i % 9) + 2}H`);
    const game = setup(2, { enemy: 'QH', maxHand: 20, tavern, hands: [['3D', '3S', '3C', 'KS'], ['2H']] });
    playCards(game, 0, ['3D', '3S', '3C']);
    expect(game.enemyDamage).toBe(18);
    expect(shieldValue(game)).toBe(9);
    expect(game.hands[0].length + game.hands[1].length).toBe(2 + 9);
  });

  it('8♦ with the Clubs companion: attack 9, draw 9, deal 18', () => {
    const tavern = Array.from({ length: 12 }, (_, i) => `${(i % 9) + 2}H`);
    const game = setup(2, { enemy: 'QS', maxHand: 20, tavern, hands: [['8D', 'AC', 'KS'], ['2H']] });
    playCards(game, 0, ['8D', 'AC']);
    expect(game.enemyDamage).toBe(18);
    expect(game.hands[0].length + game.hands[1].length).toBe(2 + 9);
  });

  it('a companion with a card of the same suit applies that power once', () => {
    const game = setup(2, { enemy: 'QH', hands: [['AS', '9S', 'KD'], ['2H']] });
    playCards(game, 0, ['AS', '9S']);
    expect(shieldValue(game)).toBe(10); // not 20
  });

  it('two Jacks together exceed 10, so royals cannot form sets', () => {
    expect(validatePlay(['JC', 'JD'])).toMatch(/10 or less/);
    expect(validatePlay(['AH', 'KS'])).toBeNull();
  });

  it('clubs played before a Jester against a Clubs enemy are not doubled afterwards', () => {
    const game = setup(3, { enemy: 'JC', hands: [['5C', 'KS'], ['X1', 'KH'], ['2D', 'QD']] });
    playCards(game, 0, ['5C']);
    expect(game.enemyDamage).toBe(5);
    discardCards(game, 0, ['KS']);
    playCards(game, 1, ['X1']);
    expect(game.enemyDamage).toBe(5);
  });
});

describe('defeating enemies', () => {
  it('exact damage puts the enemy on top of the tavern; same player goes again', () => {
    const game = setup(2, { enemy: 'JC', enemyDamage: 14, hands: [['6H', '2S'], ['3H']] });
    playCards(game, 0, ['6H']);
    expect(game.tavern[0]).toBe('JC');
    expect(game.defeated).toEqual(['JC']);
    expect(game.currentSeat).toBe(0);
    expect(game.phase).toBe('play');
    expect(game.enemy![0]).toBe('J');
    expect(game.enemyDamage).toBe(0);
  });

  it('overkill sends the enemy to the discard pile', () => {
    const game = setup(2, { enemy: 'JH', enemyDamage: 15, hands: [['8C', '2S'], ['3H']] });
    playCards(game, 0, ['8C']);
    expect(game.discard).toContain('JH');
    expect(game.discard).toContain('8C');
  });

  it('wins after the last king falls', () => {
    const game = setup(1, { enemy: 'KH', castle: [], enemyDamage: 35, hands: [['5S']] });
    playCards(game, 0, ['5S']);
    expect(game.phase).toBe('won');
    expect(soloTier(game)).toBe('gold');
  });
});

describe('yielding and losing', () => {
  it('cannot yield when everyone else just yielded', () => {
    const game = setup(2, { enemy: 'JC', hands: [['KS', 'QS'], ['KH', 'QH']] });
    expect(yieldTurn(game, 0)).toBeNull();
    discardCards(game, 0, ['KS']);
    expect(canYield(game)).toBe(false);
    expect(yieldTurn(game, 1)).toMatch(/can't yield/);
  });

  it('checks every other player\'s last turn, even after a Jester reorders play', () => {
    // 3 players: seat 1 yields, seat 2 plays a Jester and hands the turn back to seat 1,
    // who then yields again; seat 0's last turn was a play, so seat 2 may still yield later.
    const game = setup(3, { enemy: 'JC', currentSeat: 1, hands: [['KS'], ['KH', 'QH', 'X1'], ['X2', 'KD', 'QD']] });
    expect(yieldTurn(game, 1)).toBeNull();
    discardCards(game, 1, ['KH']);
    expect(playCards(game, 2, ['X2'])).toBeNull();
    chooseNextPlayer(game, 2, 1);
    // Others' last turns: seat 0 never played (not a yield), seat 2 played the Jester.
    expect(canYield(game)).toBe(true);
    expect(yieldTurn(game, 1)).toBeNull();
    discardCards(game, 1, ['QH']);
    // Seat 2: seat 0 hasn't yielded, so seat 2 may yield.
    expect(canYield(game)).toBe(true);
    // Make seat 0 yield too, then seat 1 (both others yielded) can't.
    game.lastTurnYielded = [true, false, true];
    game.currentSeat = 1;
    expect(canYield(game)).toBe(false);
  });

  it('never allows yielding in solo; an empty hand with no flips left loses', () => {
    const game = setup(1, { enemy: 'JC', hands: [['KS', '2C']], soloJestersLeft: 0 });
    expect(canYield(game)).toBe(false);
    expect(yieldTurn(game, 0)).toMatch(/solo/);
    const empty = setup(1, { enemy: 'JC', enemyDamage: 0, hands: [['10S']], soloJestersLeft: 0, tavern: [] });
    playCards(empty, 0, ['10S']); // shield 10 → no damage, next turn starts with an empty hand
    expect(empty.phase).toBe('lost');
    expect(empty.loseReason).toMatch(/no cards/);
  });

  it('solo with an empty hand and a flip left must flip, then continues', () => {
    const game = setup(1, { enemy: 'JC', hands: [['10S']], soloJestersLeft: 1, tavern: ['9H', '8D'] });
    playCards(game, 0, ['10S']);
    expect(game.phase).toBe('play');
    expect(game.hands[0]).toEqual([]);
    expect(flipSoloJester(game, 0)).toBeNull();
    expect(game.hands[0]).toEqual(['9H', '8D']);
  });

  it('loses when the hand cannot cover the damage', () => {
    const game = setup(2, { enemy: 'QC', hands: [['2S', '3H'], ['KH']] });
    playCards(game, 0, ['2S']);
    expect(game.phase).toBe('lost');
    expect(game.loseReason).toMatch(/13 damage/);
  });

  it('solo Jester flip refills the hand and can save a doomed turn', () => {
    const game = setup(1, { enemy: 'JC', tavern: ['KS', 'QS', '9H'], hands: [['2S']] });
    playCards(game, 0, ['2S']);
    expect(game.phase).toBe('discard');
    expect(handValue(game.hands[0])).toBe(0);
    expect(flipSoloJester(game, 0)).toBeNull();
    expect(game.hands[0]).toEqual(['KS', 'QS', '9H']);
    expect(discardCards(game, 0, ['KS'])).toBeNull();
    expect(game.phase).toBe('play');
    expect(game.soloJestersLeft).toBe(1);
  });

  it('rejects moves out of turn', () => {
    const game = setup(2, { enemy: 'JC', hands: [['2S'], ['3H']] });
    expect(playCards(game, 1, ['3H'])).toMatch(/not your turn/);
  });
});

describe('random full games never corrupt the deck', () => {
  it('conserves all 52+ cards through many random turns', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const rng = seeded(seed);
      const n = (seed % 4) + 1;
      const game = newGame(n, rng);
      for (let step = 0; step < 400 && game.phase !== 'won' && game.phase !== 'lost'; step++) {
        const seat = game.currentSeat;
        const hand = game.hands[seat];
        if (game.phase === 'play') {
          const sorted = [...hand].sort((a, b) => cardValue(b) - cardValue(a));
          if (sorted.length && (rng() < 0.9 || !canYield(game))) playCards(game, seat, [sorted[0]], rng);
          else if (n === 1 && game.soloJestersLeft && !hand.length) flipSoloJester(game, seat);
          else yieldTurn(game, seat);
        } else if (game.phase === 'discard') {
          const sorted = [...hand].sort((a, b) => cardValue(a) - cardValue(b));
          const pick: string[] = [];
          for (const c of sorted.reverse()) { if (handValue(pick) >= game.pendingDamage) break; pick.push(c); }
          if (discardCards(game, seat, pick)) flipSoloJester(game, seat);
        } else if (game.phase === 'jester') {
          chooseNextPlayer(game, seat, (seat + 1) % n);
        }
        const total = game.tavern.length + game.discard.length + game.castle.length + game.hands.flat().length
          + game.played.flatMap((p) => p.cards).length + (game.enemy ? 1 : 0);
        expect(total).toBe(52 + (n >= 3 ? n - 2 : 0));
      }
    }
  });
});

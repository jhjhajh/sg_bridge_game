from math import floor
from random import random

DECK_SIZE = 52
HAND_SIZE = 13
POINTS_TO_WASH = 4
NUM_PLAYERS = 4

DECK_OF_52 = [{"value": "2", "suit": "♣"}, {"value": "2", "suit": "♦"}, {"value": "2", "suit": "♥"}, {"value": "2", "suit": "♠"}, {"value": "3", "suit": "♣"}, {"value": "3", "suit": "♦"}, {"value": "3", "suit": "♥"}, {"value": "3", "suit": "♠"}, {"value": "4", "suit": "♣"}, {"value": "4", "suit": "♦"}, {"value": "4", "suit": "♥"}, {"value": "4", "suit": "♠"}, {"value": "5", "suit": "♣"}, {"value": "5", "suit": "♦"}, {"value": "5", "suit": "♥"}, {"value": "5", "suit": "♠"}, {"value": "6", "suit": "♣"}, {"value": "6", "suit": "♦"}, {"value": "6", "suit": "♥"}, {"value": "6", "suit": "♠"}, {"value": "7", "suit": "♣"}, {"value": "7", "suit": "♦"}, {"value": "7", "suit": "♥"}, {"value": "7", "suit": "♠"}, {"value": "8", "suit": "♣"}, {"value": "8", "suit": "♦"}, {"value": "8", "suit": "♥"}, {"value": "8", "suit": "♠"}, {"value": "9", "suit": "♣"}, {"value": "9", "suit": "♦"}, {"value": "9", "suit": "♥"}, {"value": "9", "suit": "♠"}, {"value": "10", "suit": "♣"}, {"value": "10", "suit": "♦"}, {"value": "10", "suit": "♥"}, {"value": "10", "suit": "♠"}, {"value": "J", "suit": "♣"}, {"value": "J", "suit": "♦"}, {"value": "J", "suit": "♥"}, {"value": "J", "suit": "♠"}, {"value": "Q", "suit": "♣"}, {"value": "Q", "suit": "♦"}, {"value": "Q", "suit": "♥"}, {"value": "Q", "suit": "♠"}, {"value": "K", "suit": "♣"}, {"value": "K", "suit": "♦"}, {"value": "K", "suit": "♥"}, {"value": "K", "suit": "♠"}, {"value": "A", "suit": "♣"}, {"value": "A", "suit": "♦"}, {"value": "A", "suit": "♥"}, {"value": "A", "suit": "♠"}]

BID_SUITS = ["♣", "♦", "♥", "♠", "🚫"]
CARD_SUITS = ["♣", "♦", "♥", "♠"]

VALUE_MAP = {14: "A", 13: "K", 12: "Q", 11: "J"}
INV_VALUE_MAP = {v: k for k, v in VALUE_MAP.items()}


def get_value_from_num(num):
    return VALUE_MAP.get(num, str(num))


def get_num_from_value(val):
    if val in INV_VALUE_MAP:
        return INV_VALUE_MAP[val]
    return int(val)


def get_bid_from_num(num):
    suit_num = num % 5
    suit = BID_SUITS[suit_num]
    value = floor(num / 5) + 1
    return str(value) + " " + suit


def get_num_from_bid(bid):
    # bid format: "1 ♣", "7 🚫" etc.
    return (int(bid[0]) - 1) * 5 + BID_SUITS.index(bid[2])


def shuffle(deck):
    for i in range(len(deck)-1, 0, -1):
        j = floor(random() * (i + 1))
        deck[i], deck[j] = deck[j], deck[i]


def get_points(hand):
    points = 0
    count = {"♣": 0, "♦": 0, "♥": 0, "♠": 0}
    for card in hand:
        count[card["suit"]] += 1
        if card["value"] == "A": points += 4
        elif card["value"] == "K": points += 3
        elif card["value"] == "Q": points += 2
        elif card["value"] == "J": points += 1
    for suit in count:
        if count[suit] >= 5:
            points += count[suit] - 4
    return points


def wash_required(hands):
    for hand in hands:
        if get_points(hand) <= POINTS_TO_WASH:
            return True
    return False


def generate_hands():
    deck = DECK_OF_52.copy()
    temp_hands = []
    shuffle(deck)
    for i in range(0, DECK_SIZE, HAND_SIZE):
        temp_hands.append(deck[i:i + HAND_SIZE])
    while wash_required(temp_hands):
        shuffle(deck)
        temp_hands = []
        for i in range(0, DECK_SIZE, HAND_SIZE):
            temp_hands.append(deck[i:i + HAND_SIZE])
    hands = []
    for i in range(NUM_PLAYERS):
        temp_hand = temp_hands[i]
        hand = {"♣": [], "♦": [], "♥": [], "♠": []}
        for card in temp_hand:
            hand[card["suit"]].append(card["value"])
        for suit in hand:
            hand[suit].sort(key=get_num_from_value, reverse=True)
        hands.append(hand)
    return hands


def generate_hand_string(hand):
    card_list = []
    for suit in CARD_SUITS:
        if len(hand[suit]):
            card_list.append(suit + "  -  " + ", ".join(hand[suit]))
        else:
            card_list.append(suit + "  -  🚫")
    return "\n".join(card_list)


def get_valid_suits(hand, trump_suit=None, current_suit=None, trump_broken=False):
    if trump_suit == "🚫":
        trump_suit = None
    valid_suits = []
    if current_suit:
        if hand[current_suit]:
            return [current_suit]
        else:
            for suit in CARD_SUITS:
                if hand[suit]:
                    valid_suits.append(suit)
    else:
        for suit in CARD_SUITS:
            if hand[suit] and (suit != trump_suit or trump_broken):
                valid_suits.append(suit)
        if not valid_suits:
            valid_suits = [trump_suit]
    return valid_suits


def compare_cards(played_cards, current_suit, trump_suit=None):
    if trump_suit == "🚫":
        trump_suit = None
    top_player = 0
    top_card = played_cards[top_player].split()
    for i in range(1, len(played_cards)):
        current_card = played_cards[i].split()
        if (current_card[1] == trump_suit and top_card[1] != trump_suit
            or current_card[1] == current_suit and top_card[1] != trump_suit and top_card[1] != current_suit
            or current_card[1] == top_card[1] and get_num_from_value(current_card[0]) > get_num_from_value(top_card[0])):
            top_player = i
            top_card = current_card
    return top_player

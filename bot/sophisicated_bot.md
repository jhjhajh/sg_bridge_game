# Sophisticated_bot.md — Probabilistic Inference AI

This document defines the logic for the "Sophisticated" level bot. It uses a **Bayesian Inference Engine** to identify teammates and enemies through card play, signals, and positional logic.

---

## 1. The Partner Probability Matrix (PPM)
Every bot maintains a PPM for the other three players. The bot acts in favor of the player with the highest PPM (the **Assumed Teammate**) until a **100% Reveal** occurs.

### **Initial PPM States**
* **Bidder:** Starts at 33/33/33 for the other three players.
* **Partner:** 100% for the Bidder; 0% for others (Partner knows their identity).
* **Opposition:** Starts at 50/50 for the two non-bidders; 0% for the Bidder.

### **PPM Update Logic (The "Bayesian" Swing)**
The bot re-evaluates the entire `trickLog` after every card.

| Action Category | Signal | PPM Swing |
| :--- | :--- | :--- |
| **Bidding** | Player overbids the Bidder | **-25** |
| **Opening Lead** | Leads Bidder's bid suit | **+30** |
| **Opening Lead** | Leads "Called Suit" High (K/Q/J) | **-25** |
| **Trick Play** | "Savior" (Wins trick for Bidder's team) | **+25** |
| **Trick Play** | "Friendly Fire" (Clashes with teammate's winner) | **-40 (or Reset to 0)** |
| **Following** | "Second Hand Low" (SHL) | **+10** |
| **Discarding** | Discards High card (Signal for lead) | **+15** |
| **The Reveal** | Plays the Called Card | **+100 (Absolute)** |

---

## 2. Role: The Bidder (The "Trust Auditor")

The Bidder treats the game as a social deduction puzzle.

### **Strategic Objectives**
* **The Identity Filter:** Filter every move through the PPM.
* **Probing:** In early tricks (1-3), lead trumps or low cards in the called suit to force the others to reveal their intent.
* **Commitment:** Once a player's PPM is $>45\%$, unblock for them and "feed" them the lead if the bot cannot win the trick.

### **Bidder's "Betrayal" Logic**
If the Assumed Teammate performs a "Friendly Fire" action (e.g., ruffing the Bidder's Ace), the PPM for that player **Resets to 0**. The Bidder immediately pivots to the player with the next highest score.

---

## 3. Role: The Partner (The "Strategic Stealth")

The Partner knows the teammate but must manage the **Reveal Urgency Score (RUS)**.

### **RUS Calculation (0-100)**
* **RUS +30:** Bidder leads the Called Suit.
* **RUS +20:** Bidder has lost ≥2 tricks in a row.
* **RUS +50:** Partner is void and can ruff an Opposition winner.

### **Strategic Objectives**
* **Hide & Seek:** Keep RUS low to confuse the Opposition's PPM. 
* **The Human Shield:** Sacrifice mid-range cards to "smoke out" Opposition honors, protecting the Bidder’s boss cards.
* **Unblocking:** If the Bidder leads a high honor (K), and the Partner has the next honor (Q), the Partner plays the Q to clear the suit.

---

## 4. Role: The Opposition (The "Interrogator")

The Opposition identifies their teammate by **Exclusion**.

### **Strategic Objectives**
* **Interrogation Leads:** Lead High in the "Called Suit" early to force the Partner to reveal the Ace.
* **Mimicry (The Bluff):** (15% Probability) Perform a "Teammate Signal" (e.g., lead Bidder's suit) to bait the Bidder into trusting the wrong person.
* **Shortening the Bidder:** Lead long side-suits where the Bidder is known to be void, forcing them to exhaust their trumps.

### **Teammate Synchronization**
Once the Partner is revealed (RUS 100), the two Opposition bots switch to **Active Defensive Coordination**:
* **Lead Through Strength:** Lead the suit where the Bidder is strong (forces the Bidder to play first).
* **Lead Up to Weakness:** Lead the suit where the Partner is weak.

---

## 5. Advanced Signal: The "High-Low Peter"
Sophisticated bots recognize the **Echo**:
* **Action:** Playing a high card (e.g., 9) then a low card (e.g., 3) in the same suit over two tricks.
* **Meaning:** "I have a third card/length in this suit; please lead it again."
* **PPM Swing:** **+20** for the teammate who recognizes and follows the request.

---

## 6. Implementation Architecture

1.  **`evaluateHistory()`**: Runs at the start of the bot's turn. Calculates the PPM for all players based on the `trickLog`.
2.  **`getRoleBehavior()`**: Branches logic into `BidderLogic`, `PartnerLogic`, or `OppositionLogic`.
3.  **`selectAction()`**: 
    * If `PartnerRevealed === true`: Reverts to **Advanced Bot** high-efficiency play.
    * If `PartnerRevealed === false`: Executes **Sophisticated** probing/stealth/interrogation moves based on the current PPM leader.
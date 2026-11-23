# Cardholder Profiles

Intactix B.V. has Wise debit cardholders and Revolut card activity. When card spend appears
in the bank feed without a receipt, the agent must chase the correct person.

## Cardholders

| Cardholder | Card last 4 digits | Full name as in Wise reference |
|---|---|---|
| Jani | 7237 | Jani Goran Saarinen |
| Mari | 3826 | Mari-Annina Oksala |
| Mari | 3699 | Revolut card usage |

All Revolut card usage goes to Mari unless a stronger explicit source says otherwise.

## How to identify the cardholder from a transaction reference

Wise includes structured text in the bank transaction reference. Example:

```
Card transaction of 60.77 AUD issued by Smp*Apres Surf Burleigh Head (fee: 0.16 EUR)
(AUD 60.77 at 1.67080 rate) | Cardholder: Jani Goran Saarinen, Card last 4 digits: 7237
```

Primary match: `Card last 4 digits: XXXX` — extract the 4-digit suffix and look up above.
Fallback match: `Cardholder: <Full Name>` — match against the name column above.

If neither pattern is found, the cardholder is unknown and the spend orphan will have
`cardholder = null`. Flag it for manual review.

## Supplier-specific cardholder hints

- KVK / Kvk.nl transactions are usually paid using Mari's card. When a KVK-related
  transaction lacks a clear cardholder, chase Mari first unless the bank/card reference
  points to someone else.

## Chase instructions (decision queue)

When `detect_spend_orphans` flags a card spend, the decision queue entry will say:

> "Unmatched Wise card spend EUR X at 'Merchant' on YYYY-MM-DD. Cardholder: [Name] (card ...XXXX).
> Please email the receipt to the Xero bills inbox so it can be matched and coded."

**What to do:** Forward the receipt (PDF) from the cardholder to `xero@intactix.io`
(the controlled supplier-invoice mailbox, read via IMAP). Then run `poll_mailbox_inbox`
to pick up the attachment, `download_mailbox_attachment` to read it, and
`create_bill_from_mailbox_file` (dry_run=true first) to create the DRAFT bill. To keep the
same dedup/matching convention the old flow used, pass `reference="SPEND:<xero_bank_tx_id>"`
so it lines up with the bank_spend_orphans row and the existing ACCPAY-reference dedupe check.
(`poll_xero_inbox` / `match_inbox_file_to_spend` / `apply_inbox_match` still work against the
legacy Xero Files inbox if a receipt ever lands there instead, but the mailbox is now primary.)

## Non-card supplier invoices

For non-card bank spend (supplier payments via bank transfer) the same workflow applies,
but the chase goes to whoever manages the supplier relationship — typically Jani. The
decision queue question will name the supplier and amount.

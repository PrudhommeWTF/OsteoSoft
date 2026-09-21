# Facturation et comptabilite

## Numerotation des factures

La numerotation est attribuee par le SERVEUR, de facon sequentielle, continue et
sans trou (exigence comptable). Elle n'est plus generee cote navigateur.

- Modules : `server/lib/billing.mjs` (numerotation) et `office-settings.mjs`
  (formats).
- Une table `invoice_number_sequences (office_id, period_key, last_value)` tient
  le compteur par cabinet et par periode. Elle est creee et amorcee depuis les
  factures existantes par une migration versionnee (voir migrations.md).
- A la creation (`POST /api/billing/invoices`), le numero est attribue dans la
  transaction, via `allocateNextInvoiceNumber`. Le prochain compteur est le
  maximum entre la valeur enregistree et le plus grand suffixe deja present
  (numeros importes inclus), plus un : impossible d'entrer en collision.
- Le numero envoye par le client est ignore ; le serveur renvoie le numero
  attribue.
- Formats supportes (prefixe + largeur), via `buildInvoiceNumberParts` :
  `AAAA-XXXXXX`, `AAAAMM-XXXXXX`, `AAAAMMJJ-XXXXXX`, et les variantes a
  reinitialisation mensuelle/annuelle.

Cote frontend, l'ordre a ete inverse : la facture est creee d'abord (le serveur
attribue le numero), puis le PDF est construit avec ce numero. La piece et
l'enregistrement comptable portent donc le meme numero. Trois ecrans concernes :
fiche patient, espace consultation, assistant de creation patient.

## Immutabilite

Aucune route ne modifie une facture emise (seuls les paiements sont modifiables).
L'annulation est conservatrice : la facture passe au statut `annulee`, elle n'est
pas supprimee, et ses paiements sont retires. Le numero n'est jamais reattribue,
la sequence continue sans trou.

## Livre de recettes (micro-BNC)

Journal chronologique des recettes ENCAISSEES, tenu en tresorerie.

- Module : `server/lib/accounting.mjs`, `getRecettesJournal`.
- Une ligne par encaissement, datee par la date de paiement (pas par la date
  d'emission de la facture). Source : `invoice_payments` jointes aux factures et
  patients. Une facture annulee a ses paiements supprimes, donc elle est
  naturellement absente du livre.
- Route : `GET /api/billing/recettes` (format `json` pour l'affichage, `csv` pour
  le livre telechargeable avec ligne de total ; export csv reserve au droit
  `export-billing`). Colonnes : date d'encaissement, client, numero de facture,
  mode de reglement, montant, devise.

## Registre des operations (comptabilite generale)

Distinct du livre de recettes. `getBillingOperationsData` agrege factures,
depenses et depots sur une periode, date a l'emission (comptabilite
d'engagement), avec debits et credits. Sert aux ecrans de comptabilite, aux
apercus, previsions et alertes, et a l'export `GET /api/billing/export`.

# OsteoSoft — Extension d'import Doctolib Pro

Extension de navigateur (Chrome / Edge, **Manifest V3**) qui ajoute un bouton
sur la fiche de détail d'un rendez-vous de [Doctolib Pro](https://pro.doctolib.fr)
pour l'importer — avec le patient associé — directement dans **OsteoSoft**.

## Fonctionnement

1. Sur une fiche rendez-vous de `pro.doctolib.fr`, l'extension affiche un bouton
   flottant **« Ajouter à OsteoSoft »**.
2. Au clic, elle lit les informations du rendez-vous (patient, motif, horaire)
   et ouvre une fenêtre de revue.
3. L'ostéopathe vérifie/corrige les champs, choisit de **lier** le rendez-vous à
   un patient OsteoSoft existant, de **créer** une nouvelle fiche patient, ou
   d'utiliser un **patient rapide** (nom seul), puis confirme.
4. L'extension crée le rendez-vous (et, si demandé, le patient) via l'API
   OsteoSoft.

### Pourquoi ce fonctionnement ?

- **Aucun mot de passe stocké** : l'extension réutilise la session OsteoSoft déjà
  ouverte dans le navigateur (cookie de session `os_session`). L'ostéopathe doit
  simplement être connecté à OsteoSoft.
- **Revue avant enregistrement** : évite les doublons de patients et permet de
  corriger un motif ou un horaire mal détecté — important pour un logiciel de
  santé (RGPD).
- **Appels centralisés dans le service worker** : les requêtes vers OsteoSoft
  partent du *background* de l'extension (autorisé par une *host permission*),
  ce qui contourne proprement le CORS de la page Doctolib. Le jeton CSRF
  (`os_csrf`) est lu et renvoyé dans l'en-tête `x-csrf-token`, comme l'exige
  l'API OsteoSoft.

## Installation (mode développeur)

1. Ouvrez `chrome://extensions` (ou `edge://extensions`).
2. Activez le **mode développeur**.
3. Cliquez sur **« Charger l'extension non empaquetée »** et sélectionnez ce
   dossier (`extensions/doctolib-osteosoft`).
4. Ouvrez les **options** de l'extension et renseignez l'URL de l'API OsteoSoft
   (par défaut `http://localhost:4199`), puis cliquez sur
   **« Autoriser l'accès à OsteoSoft »**.

## Configuration

| Paramètre | Description | Défaut |
| --- | --- | --- |
| Adresse de l'API OsteoSoft | Origine où répond l'API Express d'OsteoSoft | `http://localhost:4199` |

L'URL est configurable pour couvrir aussi bien le développement local qu'une
installation hébergée. L'autorisation d'accès à cette origine est demandée
dynamiquement (permission optionnelle) afin de ne pas réclamer un accès large à
l'installation.

## Prérequis côté OsteoSoft

- Être **connecté** à OsteoSoft dans le même navigateur.
- Disposer des droits `create-patient-record`, `create-appointment` et
  `read-patient-list` (utilisés par les endpoints appelés).

En développement, l'API autorise par défaut l'origine `http://localhost:4200`
via CORS ; l'extension n'est pas concernée par cette restriction car ses
requêtes partent du service worker avec la *host permission* accordée.

## Données extraites de Doctolib

| Champ OsteoSoft | Source sur la fiche Doctolib |
| --- | --- |
| Nom / Prénom | Titres du panneau patient (`h1`) |
| Sexe / Date de naissance | Ligne « H, jj/mm/aaaa » |
| Téléphone | `a[data-test-id="phone_number"]` |
| E-mail | `a[data-test-id="email"]` |
| Motif | Champ « Motif de consultation » (`#appointment_visit_motive_id`) |
| Horaire | Champ « Horaire » (`#appointment_start_date` + timepicker) |

Un repli sur l'historique « à venir » (`[data-test-id="patient-history-list-item"]`)
est utilisé si le formulaire d'édition n'est pas ouvert.

## Structure

```
doctolib-osteosoft/
├── manifest.json           # Manifest V3
├── icons/                  # Icônes 16/32/48/128
└── src/
    ├── background.js        # Service worker : client API OsteoSoft (CSRF, import)
    ├── content/
    │   ├── scraper.js       # Extraction du DOM Doctolib
    │   ├── panel.js         # Modale de revue/confirmation (Shadow DOM)
    │   ├── panel.css        # Styles de l'hôte
    │   └── content.js       # Injection du bouton + observation de la SPA
    ├── options/             # Page d'options (URL, autorisation, test)
    └── popup/               # Popup de la barre d'outils (statut)
```

## Limites connues

- Le DOM de Doctolib Pro peut évoluer ; les sélecteurs privilégient les attributs
  stables mais restent susceptibles de casser lors d'une refonte Doctolib.
- L'extraction couvre les champs essentiels (identité, contact, motif, horaire) ;
  l'adresse postale et d'autres champs facultatifs ne sont pas repris
  automatiquement.
- Testé pour Chromium (Chrome/Edge). Firefox nécessiterait des ajustements MV3.

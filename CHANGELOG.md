# Changelog

Toutes les modifications notables de ce projet sont documentées dans ce fichier.

Le format est basé sur [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/),
et ce projet adhère au [Versionnage Sémantique](https://semver.org/lang/fr/).

## [0.0.2] - 2025-05-01

### Nouvelles fonctionnalités

- Gestion des accès patients par cabinet avec contrôle d'accès multi-cabinet
- Chiffrement AES-256-GCM des données bancaires sensibles (IBAN, RIB)
- Importation de contacts WebOsteo et correspondants médicaux
- Génération de PDF pour les factures et les consultations
- Anonymisation RGPD des patients avec retrait de consentement
- Tableau de bord avec statistiques mensuelles et indicateurs clés
- Gestion des agendas avec créneaux configurables
- Comptabilité avec suivi des paiements et des acomptes

### Corrections de bugs

- Correction de la gestion des tokens lors du changement de mot de passe
- Correction de l'affichage des patients sans cabinet associé

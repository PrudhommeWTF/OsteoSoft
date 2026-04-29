export type HelpActionGuide = {
  title: string;
  manipulations: readonly string[];
  useCases: readonly string[];
};

export type HelpScreenGuide = {
  slug: string;
  title: string;
  appRoute: string;
  screenshot: string;
  summary: string;
  actions: readonly HelpActionGuide[];
};

export const HELP_GUIDES: readonly HelpScreenGuide[] = [
  {
    slug: 'accueil',
    title: 'Accueil',
    appRoute: '/accueil',
    screenshot: '/help/accueil.png',
    summary: 'Vue synthese des activites du cabinet, des patients recents et des paiements en attente.',
    actions: [
      {
        title: 'Consulter les indicateurs du tableau de bord',
        manipulations: [
          'Ouvrir le menu lateral puis cliquer sur Accueil.',
          'Lire les blocs des patients recents et des paiements en attente.',
          'Verifier les tendances globales avant de demarrer la journee.'
        ],
        useCases: [
          'Prendre une decision rapide sur les priorites du jour.',
          'Identifier les factures ou relances a traiter en premier.',
          'Verifier l activite generale du cabinet sur la periode.'
        ]
      },
      {
        title: 'Piloter le mini calendrier de consultation',
        manipulations: [
          'Utiliser les boutons periode precedente / suivante.',
          'Cliquer sur Aujourd hui pour recentrer la vue.',
          'Basculer entre les modes Mois, Semaine, 3 jours et Jour.'
        ],
        useCases: [
          'Reperer rapidement les plages chargees.',
          'Verifier la disponibilite avant de proposer un rendez-vous.',
          'Presenter une vision planning claire a un secretaire.'
        ]
      }
    ]
  },
  {
    slug: 'agenda',
    title: 'Agenda',
    appRoute: '/agenda',
    screenshot: '/help/agenda.png',
    summary: 'Planification des rendez-vous et navigation fine par date, praticien et statut.',
    actions: [
      {
        title: 'Creer un rendez-vous',
        manipulations: [
          'Aller sur Agenda puis choisir un creneau horaire libre.',
          'Saisir patient, motif et duree puis valider.',
          'Verifier que le rendez-vous apparait dans la bonne colonne de date.'
        ],
        useCases: [
          'Programmer une premiere consultation patient.',
          'Ajouter un controle de suivi apres une seance.',
          'Bloquer un creneau interne non medical.'
        ]
      },
      {
        title: 'Modifier ou deplacer un rendez-vous',
        manipulations: [
          'Cliquer sur un rendez-vous existant.',
          'Mettre a jour heure, duree, statut ou commentaire.',
          'Enregistrer puis verifier la coherence dans la vue.'
        ],
        useCases: [
          'Decaler un patient suite a un retard.',
          'Passer un rendez-vous en confirme, annule ou a confirmer.',
          'Ajouter des details utiles pour la consultation.'
        ]
      }
    ]
  },
  {
    slug: 'patients',
    title: 'Listing patients',
    appRoute: '/patients',
    screenshot: '/help/patients.png',
    summary: 'Recherche, tri et navigation rapide vers la fiche detaillee des patients.',
    actions: [
      {
        title: 'Rechercher un patient',
        manipulations: [
          'Saisir le nom dans la barre de recherche.',
          'Utiliser la pagination pour parcourir les resultats.',
          'Ajuster le nombre de lignes affichees par page.'
        ],
        useCases: [
          'Retrouver une fiche en quelques secondes a l accueil du cabinet.',
          'Verifier si un patient existe deja avant creation.',
          'Preparer un appel de confirmation de rendez-vous.'
        ]
      },
      {
        title: 'Ouvrir la fiche d un patient',
        manipulations: [
          'Cliquer sur une ligne du tableau patient.',
          'Attendre l ouverture automatique de la fiche detail.',
          'Naviguer ensuite vers les consultations ou documents associes.'
        ],
        useCases: [
          'Mettre a jour les coordonnees avant une visite.',
          'Acceder a l historique clinique.',
          'Verifier les informations administratives pour la facturation.'
        ]
      }
    ]
  },
  {
    slug: 'fiche-patient',
    title: 'Fiche patient',
    appRoute: '/patients/:id',
    screenshot: '/help/fiche-patient.png',
    summary: 'Dossier complet patient: identite, contexte clinique, suivi et actes.',
    actions: [
      {
        title: 'Mettre a jour la fiche administrative',
        manipulations: [
          'Ouvrir la fiche puis modifier les champs utiles.',
          'Verifier les informations de contact et les remarques importantes.',
          'Enregistrer les changements et valider l affichage.'
        ],
        useCases: [
          'Changement de telephone ou d adresse.',
          'Ajout d une information utile au secretariat.',
          'Preparation d un dossier avant transmission.'
        ]
      },
      {
        title: 'Suivre les consultations et actes',
        manipulations: [
          'Acceder a la section consultations depuis la fiche.',
          'Ouvrir une consultation existante pour lecture ou mise a jour.',
          'Creer une nouvelle consultation si necessaire.'
        ],
        useCases: [
          'Continuer une prise en charge deja engagee.',
          'Comparer l evolution des symptomes dans le temps.',
          'Documenter une nouvelle seance apres rendez-vous.'
        ]
      }
    ]
  },
  {
    slug: 'repertoire',
    title: 'Repertoire',
    appRoute: '/repertoire',
    screenshot: '/help/repertoire.png',
    summary: 'Annuaire des correspondants et contacts du cabinet (medecins, partenaires, etc.).',
    actions: [
      {
        title: 'Consulter et filtrer les contacts',
        manipulations: [
          'Ouvrir Repertoire puis utiliser la recherche ou les filtres disponibles.',
          'Cliquer sur une fiche contact pour afficher les details.',
          'Verifier email, telephone et categorie avant action.'
        ],
        useCases: [
          'Retrouver rapidement un medecin adresseur.',
          'Verifier les coordonnees avant un courrier.',
          'Identifier un contact par specialite.'
        ]
      },
      {
        title: 'Creer ou modifier un contact',
        manipulations: [
          'Utiliser le bouton d ajout ou d edition.',
          'Saisir les champs obligatoires puis enregistrer.',
          'Controler la presence du contact dans la liste apres sauvegarde.'
        ],
        useCases: [
          'Ajouter un nouveau partenaire local.',
          'Corriger un numero de telephone obsolete.',
          'Maintenir une base de correspondants propre.'
        ]
      }
    ]
  },
  {
    slug: 'facturation',
    title: 'Facturation',
    appRoute: '/facturation',
    screenshot: '/help/facturation.png',
    summary: 'Suivi des paiements, encaissements et pilotage des factures du cabinet.',
    actions: [
      {
        title: 'Suivre les factures et paiements',
        manipulations: [
          'Ouvrir Facturation puis consulter les indicateurs de suivi.',
          'Filtrer les lignes par statut ou periode.',
          'Verifier les montants, echeances et moyens de paiement.'
        ],
        useCases: [
          'Prioriser les relances de factures impayees.',
          'Preparer une vue synthese en fin de semaine.',
          'Controler la coherence des reglements saisis.'
        ]
      },
      {
        title: 'Mettre a jour le statut de reglement',
        manipulations: [
          'Ouvrir la ligne de facture concernee.',
          'Saisir la date et le moyen de reglement.',
          'Valider puis controler la mise a jour du tableau de suivi.'
        ],
        useCases: [
          'Marquer une facture comme reglee apres reception du paiement.',
          'Corriger un statut errone.',
          'Fiabiliser la comptabilite courante du cabinet.'
        ]
      }
    ]
  },
  {
    slug: 'statistiques',
    title: 'Statistiques',
    appRoute: '/statistiques',
    screenshot: '/help/statistiques.png',
    summary: 'Analyse des performances du cabinet: activite, patientele et tendances temporelles.',
    actions: [
      {
        title: 'Analyser une periode d activite',
        manipulations: [
          'Choisir une periode depuis les controles de la page.',
          'Lire les courbes et les histogrammes associes.',
          'Comparer les resultats avec la periode precedente.'
        ],
        useCases: [
          'Mesurer la croissance ou baisse d activite.',
          'Identifier les mois creux pour ajuster l organisation.',
          'Suivre l effet d une action de communication.'
        ]
      },
      {
        title: 'Exploiter les indicateurs de pilotage',
        manipulations: [
          'Repeter l analyse sur differents filtres.',
          'Noter les indicateurs clefs pour le reporting interne.',
          'Revenir a une vue globale pour valider la tendance generale.'
        ],
        useCases: [
          'Preparer un bilan d activite trimestriel.',
          'Partager une vision objective avec les associes.',
          'Anticiper la charge de travail a venir.'
        ]
      }
    ]
  },
  {
    slug: 'profil',
    title: 'Mon profil',
    appRoute: '/mon-profil',
    screenshot: '/help/profil.png',
    summary: 'Parametrage du compte utilisateur, preferences et options de personnalisation.',
    actions: [
      {
        title: 'Modifier les informations du compte',
        manipulations: [
          'Ouvrir Mon profil puis selectionner l onglet concerne.',
          'Mettre a jour les champs (identite, contact, mot de passe).',
          'Enregistrer et verifier le message de confirmation.'
        ],
        useCases: [
          'Mise a jour d email professionnel.',
          'Changement de mot de passe utilisateur.',
          'Correction d informations personnelles.'
        ]
      },
      {
        title: 'Ajuster les preferences d interface',
        manipulations: [
          'Acceder aux reglages interface et agenda.',
          'Choisir theme, mode PDF, options d affichage.',
          'Sauvegarder pour appliquer la personnalisation.'
        ],
        useCases: [
          'Adapter l interface au confort visuel de l utilisateur.',
          'Uniformiser les preferences d impression PDF.',
          'Optimiser le poste de travail pour un usage quotidien.'
        ]
      }
    ]
  }
];

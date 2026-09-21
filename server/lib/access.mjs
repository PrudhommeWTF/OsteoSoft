// Contrôle d'accès : modèle de permissions, contexte utilisateur et cloisonnement.
//
// Deux couches :
//  1. Un modèle de permissions PUR (catalogue des domaines/droits, construction et
//     normalisation des grilles de droits). Aucune dépendance à la base : testable
//     isolément et réutilisable côté outillage.
//  2. Une fabrique createAccessControl(db, deps) qui ferme sur la base et renvoie les
//     primitives liées à la base : résolution du contexte d'accès (rôle, profil,
//     droits, cabinets), middlewares d'autorisation (requirePermission, ...) et
//     cloisonnement par cabinet (canUserAccessPatient, périmètre de facturation).
//
// Comportement préservé à l'identique lors de l'extraction depuis server/index.mjs :
// les fonctions et leurs signatures sont inchangées, seul l'emplacement change.
//
// db est typé de façon lâche (any) : better-sqlite3 n'expose pas de types.

/** @typedef {any} Db */
/** @typedef {Record<string, Record<string, boolean>>} AccessRights */

// Identifiant du profil super-administrateur : accès global à tous les cabinets et
// à tous les droits, indépendamment de la grille de droits stockée.
export const SUPER_ADMIN_PROFILE_ID = 'super-admin';

// Catalogue des permissions, groupées par domaine fonctionnel. Source unique de
// vérité pour construire et normaliser les grilles de droits.
export const ACCESS_DOMAIN_DEFINITIONS = {
  'patient-record': [
    'read-patient-record',
    'create-patient-record',
    'delete-patient-record',
    'export-patient-record',
    'create-consultation',
    'read-consultation-detail',
    'choose-consultation-author',
    'read-protected-patient-record',
    'protect-patient-record',
    'invoice-consultation',
    'cancel-invoice'
  ],
  'patients-list': ['read-patient-list', 'search-patient-list', 'export-patient-list'],
  agenda: ['read-agenda', 'create-appointment', 'edit-appointment', 'delete-appointment', 'export-agenda'],
  billing: ['read-billing-kpis', 'create-invoice', 'customize-invoice-template', 'mark-payment', 'export-billing'],
  statistics: ['read-dashboard', 'read-advanced-statistics', 'read-peer-statistics', 'export-statistics'],
  'contact-directory': ['read-directory', 'create-directory-contact', 'edit-directory-contact', 'delete-directory-contact', 'export-directory'],
  'office-management': [
    'read-office-settings',
    'create-office',
    'update-office-settings',
    'delete-office',
    'reorder-offices',
    'manage-data-backup-restore',
    'manage-data-rgpd',
    'manage-data-import',
    'manage-data-cleanup'
  ]
};

/**
 * Construit une grille de droits complète où chaque permission vaut defaultValue.
 * @param {boolean} [defaultValue]
 * @returns {AccessRights}
 */
export function buildAccessRights(defaultValue = false) {
  return Object.entries(ACCESS_DOMAIN_DEFINITIONS).reduce((acc, [domainId, permissionIds]) => {
    acc[domainId] = permissionIds.reduce((permissions, permissionId) => {
      permissions[permissionId] = defaultValue;
      return permissions;
    }, /** @type {Record<string, boolean>} */ ({}));
    return acc;
  }, /** @type {AccessRights} */ ({}));
}

/**
 * Normalise une grille de droits brute contre le catalogue : ne conserve que les
 * permissions connues, les valeurs non booléennes retombant sur fallbackValue.
 * @param {any} rawRights
 * @param {boolean} [fallbackValue]
 * @returns {AccessRights}
 */
export function normalizeAccessRights(rawRights, fallbackValue = false) {
  const source = rawRights && typeof rawRights === 'object' ? rawRights : {};

  return Object.entries(ACCESS_DOMAIN_DEFINITIONS).reduce((acc, [domainId, permissionIds]) => {
    const sourceDomain = source[domainId] && typeof source[domainId] === 'object' ? source[domainId] : {};

    acc[domainId] = permissionIds.reduce((permissions, permissionId) => {
      if (sourceDomain[permissionId] === true || sourceDomain[permissionId] === false) {
        permissions[permissionId] = sourceDomain[permissionId];
      } else {
        permissions[permissionId] = fallbackValue;
      }
      return permissions;
    }, /** @type {Record<string, boolean>} */ ({}));

    return acc;
  }, /** @type {AccessRights} */ ({}));
}

/**
 * Construit une grille où seules les permissions listées sont activées.
 * @param {Iterable<string>} enabledPermissionIds
 * @returns {AccessRights}
 */
export function buildAccessRightsForPermissions(enabledPermissionIds) {
  const enabled = new Set(enabledPermissionIds);
  const rights = buildAccessRights(false);

  for (const domainRights of Object.values(rights)) {
    for (const permissionId of Object.keys(domainRights)) {
      if (enabled.has(permissionId)) {
        domainRights[permissionId] = true;
      }
    }
  }

  return rights;
}

/**
 * Fusionne plusieurs grilles de droits : une permission est accordée dès qu'une
 * grille au moins l'accorde (union des droits).
 * @param {any[]} rightsList
 * @returns {AccessRights}
 */
export function mergeAccessRights(rightsList) {
  const merged = buildAccessRights(false);

  for (const rights of Array.isArray(rightsList) ? rightsList : []) {
    const normalized = normalizeAccessRights(rights, false);
    for (const [domainId, domainRights] of Object.entries(normalized)) {
      for (const [permissionId, enabled] of Object.entries(domainRights)) {
        if (enabled === true) {
          merged[domainId][permissionId] = true;
        }
      }
    }
  }

  return merged;
}

/**
 * Dérive un identifiant de profil stable et lisible depuis un libellé.
 * @param {unknown} label
 * @returns {string}
 */
export function createAccessProfileId(label) {
  const base = String(label ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return `${base || 'profile'}-${Date.now()}`;
}

/**
 * Indique si une grille de droits accorde la permission demandée, tous domaines
 * confondus.
 * @param {any} rights
 * @param {string} permissionId
 * @returns {boolean}
 */
export function hasPermission(rights, permissionId) {
  for (const domainRights of Object.values(rights ?? {})) {
    if (domainRights && typeof domainRights === 'object' && domainRights[permissionId] === true) {
      return true;
    }
  }

  return false;
}

/**
 * Vrai pour un accès global (administrateur applicatif ou super-admin).
 * @param {any} access
 * @returns {boolean}
 */
export function isApplicationSuperAdmin(access) {
  return access?.role === 'admin' || access?.profileId === SUPER_ADMIN_PROFILE_ID;
}

/**
 * Identifiants de cabinets accessibles en facturation, dédupliqués et filtrés.
 * @param {any} access
 * @returns {number[]}
 */
export function getAccessibleBillingOfficeIds(access) {
  return [...new Set(
    (Array.isArray(access?.officeIds) ? access.officeIds : [])
      .map((/** @type {any} */ value) => Number(value))
      .filter((/** @type {number} */ value) => Number.isInteger(value) && value > 0)
  )];
}

/**
 * Restreint le périmètre de facturation au cabinet demandé s'il est accessible ;
 * sinon renvoie l'ensemble des cabinets accessibles (ou [] si le cabinet demandé
 * est hors périmètre).
 * @param {any} access
 * @param {any} requestedOfficeId
 * @returns {number[]}
 */
export function getScopedBillingOfficeIds(access, requestedOfficeId) {
  const allowed = new Set(getAccessibleBillingOfficeIds(access));
  const asked = Number(requestedOfficeId);
  if (Number.isInteger(asked) && asked > 0) {
    return allowed.has(asked) ? [asked] : [];
  }
  return [...allowed];
}

/**
 * Crée les primitives de contrôle d'accès liées à une base et au journal d'audit.
 * @param {Db} db
 * @param {{ writeAuthSecurityLog: (req: any, event: string, details?: Record<string, unknown>) => void }} deps
 */
export function createAccessControl(db, { writeAuthSecurityLog }) {
  /**
   * Cabinets rattachés à un utilisateur (affectations directes + délégations).
   * @param {number} userId
   */
  function getUserOfficeOptions(userId) {
    return db
      .prepare(
        `SELECT DISTINCT o.id, o.name
         FROM offices o
         WHERE o.id IN (
           SELECT office_id FROM user_offices WHERE user_id = ?
           UNION
           SELECT office_id FROM office_user_delegations WHERE user_id = ?
         )
         ORDER BY lower(o.name) ASC, o.id ASC`
      )
      .all(userId, userId)
      .map((/** @type {any} */ row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
  }

  /**
   * Cabinets visibles dans les sélecteurs : tous pour un accès global, sinon les
   * cabinets du contexte d'accès.
   * @param {any} userAccess
   * @param {boolean} isAdmin
   */
  function getScopedOfficeOptions(userAccess, isAdmin) {
    const canAccessAllOffices = isAdmin || userAccess?.profileId === SUPER_ADMIN_PROFILE_ID;
    if (canAccessAllOffices) {
      return db
        .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
        .all()
        .map((/** @type {any} */ row) => ({ id: Number(row.id), name: String(row.name ?? '').trim() }));
    }

    return Array.isArray(userAccess?.offices) ? userAccess.offices : [];
  }

  /**
   * Cabinets sur lesquels l'utilisateur peut piloter la gestion des données
   * (sauvegarde, RGPD, import, purge) : tous si super-admin, sinon les cabinets
   * où il porte une délégation super-admin, à défaut ses cabinets.
   * @param {any} userAccess
   * @returns {number[]}
   */
  function getDataManagementScopedOfficeIds(userAccess) {
    if (isApplicationSuperAdmin(userAccess)) {
      return db
        .prepare('SELECT id FROM offices ORDER BY id ASC')
        .all()
        .map((/** @type {any} */ row) => Number(row.id))
        .filter((/** @type {number} */ id) => Number.isInteger(id) && id > 0);
    }

    const delegatedSuperAdminOfficeIds = db
      .prepare(
        `SELECT office_id
         FROM office_user_delegations
         WHERE user_id = ?
           AND profile_id = ?
         ORDER BY office_id ASC`
      )
      .all(Number(userAccess?.id ?? 0), SUPER_ADMIN_PROFILE_ID)
      .map((/** @type {any} */ row) => Number(row.office_id))
      .filter((/** @type {number} */ id) => Number.isInteger(id) && id > 0);

    if (delegatedSuperAdminOfficeIds.length > 0) {
      return [...new Set(delegatedSuperAdminOfficeIds)];
    }

    return [...new Set((Array.isArray(userAccess?.officeIds) ? userAccess.officeIds : [])
      .map((/** @type {any} */ officeId) => Number(officeId))
      .filter((/** @type {number} */ officeId) => Number.isInteger(officeId) && officeId > 0))];
  }

  /**
   * Résout le contexte d'accès complet d'un utilisateur depuis la base (rôle,
   * profil, cabinets, grille de droits effective). Renvoie null si l'utilisateur
   * est introuvable ou désactivé. La grille est lue à chaud pour ne pas dépendre
   * d'un jeton signé avant un changement de droits.
   * @param {number} userId
   */
  function getUserAccessContext(userId) {
    const row = db
      .prepare(
        `SELECT u.id, u.username, u.role, u.is_active, u.profile_id, p.label AS profile_label, p.rights_json
         FROM users u
         LEFT JOIN access_profiles p ON p.id = u.profile_id
         WHERE u.id = ?`
      )
      .get(userId);

    if (!row || !row.is_active) {
      return null;
    }

    let parsedRights;
    try {
      parsedRights = row.rights_json ? JSON.parse(row.rights_json) : {};
    } catch {
      parsedRights = {};
    }

    const delegatedRightsRows = db
      .prepare(
        `SELECT p.rights_json
         FROM office_user_delegations oud
         INNER JOIN access_profiles p ON p.id = oud.profile_id
         WHERE oud.user_id = ?`
      )
      .all(userId);

    const delegatedRights = delegatedRightsRows.map((/** @type {any} */ delegation) => {
      try {
        return delegation.rights_json ? JSON.parse(delegation.rights_json) : {};
      } catch {
        return {};
      }
    });

    const hasGlobalOfficeAccess = row.role === 'admin' || row.profile_id === SUPER_ADMIN_PROFILE_ID;
    let offices = hasGlobalOfficeAccess
      ? db
        .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
        .all()
        .map((/** @type {any} */ office) => ({ id: Number(office.id), name: String(office.name ?? '').trim() }))
      : getUserOfficeOptions(row.id);

    if (hasGlobalOfficeAccess && offices.length === 0) {
      // Legacy fallback: old datasets may have offices marked inactive by mistake.
      offices = db
        .prepare('SELECT id, name FROM offices ORDER BY lower(name) ASC, id ASC')
        .all()
        .map((/** @type {any} */ office) => ({ id: Number(office.id), name: String(office.name ?? '').trim() }));
    }

    offices = offices.filter((/** @type {any} */ office) => Number.isInteger(office.id) && office.id > 0 && office.name.length > 0);
    const officeIds = offices.map((/** @type {any} */ office) => office.id);

    return {
      id: row.id,
      username: row.username,
      role: row.role,
      profileId: row.profile_id ?? null,
      profileLabel: row.profile_label ?? null,
      officeIds,
      offices,
      rights: hasGlobalOfficeAccess
        ? buildAccessRights(true)
        : mergeAccessRights(delegatedRights.length > 0 ? delegatedRights : [parsedRights])
    };
  }

  /**
   * Middleware : réserve la route aux administrateurs / super-admins. Le rôle est
   * relu en base (pas depuis le JWT) pour qu'une rétrogradation prenne effet
   * immédiatement.
   * @param {any} req
   * @param {any} res
   * @param {any} next
   */
  function adminOnlyMiddleware(req, res, next) {
    const access = getUserAccessContext(req.user.sub);

    if (access && (access.role === 'admin' || access.profileId === SUPER_ADMIN_PROFILE_ID)) {
      req.userAccess = access;
      return next();
    }

    return res.status(403).json({ message: 'Acces refuse' });
  }

  /**
   * Middleware : exige une permission précise. Les accès globaux passent toujours ;
   * un refus est journalisé au titre de la sécurité.
   * @param {string} permissionId
   */
  function requirePermission(permissionId) {
    return (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      const access = getUserAccessContext(req.user.sub);
      if (!access) {
        return res.status(401).json({ message: 'Session invalide' });
      }

      if (access.role === 'admin' || access.profileId === SUPER_ADMIN_PROFILE_ID) {
        req.userAccess = access;
        return next();
      }

      if (!hasPermission(access.rights, permissionId)) {
        writeAuthSecurityLog(req, 'authorization_denied', {
          userId: access.id,
          username: access.username,
          profileId: access.profileId,
          permissionId,
          reason: 'missing_permission'
        });
        return res.status(403).json({ message: 'Droit insuffisant' });
      }

      req.userAccess = access;
      return next();
    };
  }

  /**
   * Middleware : exige au moins une des permissions listées.
   * @param {string[]} permissionIds
   */
  function requireAnyPermission(permissionIds) {
    const normalizedPermissionIds = Array.isArray(permissionIds)
      ? permissionIds.map((permissionId) => String(permissionId ?? '').trim()).filter((permissionId) => permissionId.length > 0)
      : [];

    return (/** @type {any} */ req, /** @type {any} */ res, /** @type {any} */ next) => {
      const access = getUserAccessContext(req.user.sub);
      if (!access) {
        return res.status(401).json({ message: 'Session invalide' });
      }

      if (access.role === 'admin' || access.profileId === SUPER_ADMIN_PROFILE_ID) {
        req.userAccess = access;
        return next();
      }

      const hasAnyPermission = normalizedPermissionIds.some((permissionId) => hasPermission(access.rights, permissionId));
      if (!hasAnyPermission) {
        writeAuthSecurityLog(req, 'authorization_denied', {
          userId: access.id,
          username: access.username,
          profileId: access.profileId,
          permissionIds: normalizedPermissionIds,
          reason: 'missing_any_permission'
        });
        return res.status(403).json({ message: 'Droit insuffisant' });
      }

      req.userAccess = access;
      return next();
    };
  }

  /**
   * Cloisonnement patient : un praticien accède à un patient dès qu'il a une
   * consultation ou un rendez-vous dans l'un de ses cabinets, ou que le cabinet
   * d'inscription du patient est l'un des siens. Les patients sans aucun cabinet
   * (données héritées) restent accessibles à tous pour compatibilité ascendante.
   * @param {number} patientId
   * @param {any} userAccess
   * @returns {boolean}
   */
  function canUserAccessPatient(patientId, userAccess) {
    if (!userAccess) return false;
    if (userAccess.role === 'admin' || userAccess.profileId === SUPER_ADMIN_PROFILE_ID) return true;

    const officeIds = getAccessibleBillingOfficeIds(userAccess);
    if (officeIds.length === 0) return false;

    const placeholders = officeIds.map(() => '?').join(', ');

    // Chemin rapide : patient rattaché à un cabinet accessible via consultations,
    // rendez-vous ou cabinet d'inscription (patients.office_id).
    // On utilise EXISTS ... OR ... : placer LIMIT dans chaque branche d'un
    // UNION ALL est une syntaxe SQLite invalide (levait une erreur, donc un 500
    // pour tout utilisateur non-admin, cassant de fait le cloisonnement).
    const hasAccess = db.prepare(`
      SELECT 1 WHERE
           EXISTS (SELECT 1 FROM consultations WHERE patient_id = ? AND office_id IN (${placeholders}))
        OR EXISTS (SELECT 1 FROM appointments  WHERE patient_id = ? AND office_id IN (${placeholders}))
        OR EXISTS (SELECT 1 FROM patients WHERE id = ? AND is_deleted = 0 AND office_id IN (${placeholders}))
    `).get(patientId, ...officeIds, patientId, ...officeIds, patientId, ...officeIds);

    if (hasAccess) return true;

    // Compatibilité ascendante : si le patient n'a aucun rattachement de cabinet
    // nulle part (toutes les lignes ont office_id NULL), il reste visible de tous.
    const hasAnyOfficeLink = db.prepare(`
      SELECT 1 WHERE
           EXISTS (SELECT 1 FROM consultations WHERE patient_id = ? AND office_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM appointments WHERE patient_id = ? AND office_id IS NOT NULL)
        OR EXISTS (SELECT 1 FROM patients WHERE id = ? AND office_id IS NOT NULL AND is_deleted = 0)
    `).get(patientId, patientId, patientId);

    return hasAnyOfficeLink == null;
  }

  return {
    getUserOfficeOptions,
    getScopedOfficeOptions,
    getDataManagementScopedOfficeIds,
    getUserAccessContext,
    adminOnlyMiddleware,
    requirePermission,
    requireAnyPermission,
    canUserAccessPatient
  };
}

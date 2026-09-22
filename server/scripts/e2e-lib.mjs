// Petit utilitaire commun aux scenarios end-to-end HTTP (sans interface).
//
// Ces scenarios pilotent l'API reelle (via le harnais de test, base SQLite
// temporaire et isolee) et affichent une trace lisible avec un compteur de
// verifications. Ils complementent la suite `npm run test:api` (assertions fines)
// par des parcours complets multi-modules, dans la lignee des anciens scripts
// e2e:backup / e2e:rights.

export function createScenario(label) {
  let passed = 0;
  const failures = [];

  function check(name, condition, detail = '') {
    if (condition) {
      passed += 1;
      console.log(`  ok   ${name}`);
    } else {
      const line = detail ? `${name} (${detail})` : name;
      failures.push(line);
      console.log(`  ECHEC ${line}`);
    }
  }

  function section(title) {
    console.log(`\n[${label}] ${title}`);
  }

  function finish() {
    console.log(`\n[${label}] ${passed} verification(s) OK, ${failures.length} echec(s).`);
    if (failures.length > 0) {
      process.exitCode = 1;
      return false;
    }
    return true;
  }

  return { check, section, finish };
}

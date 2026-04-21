import { TestBed } from '@angular/core/testing';

import { ApiService } from '../../core/api.service';
import { BillingAlertsPayload, BillingForecastPayload, BillingInsightsPayload, BillingOperationsPayload } from '../../core/api.types';
import { AuthService } from '../../core/auth.service';
import { BillingPage } from './billing.page';

describe('BillingPage export history alignments', () => {
  let component: BillingPage;
  let apiSpy: jasmine.SpyObj<ApiService>;
  let authSpy: jasmine.SpyObj<AuthService>;

  beforeEach(async () => {
    localStorage.clear();

    apiSpy = jasmine.createSpyObj<ApiService>('ApiService', [
      'getBillingOperations',
      'getBillingInsights',
      'getBillingForecast',
      'getBillingAlerts'
    ]);
    authSpy = jasmine.createSpyObj<AuthService>('AuthService', ['hasPermission']);

    authSpy.hasPermission.and.returnValue(true);
    apiSpy.getBillingOperations.and.resolveTo(buildOperationsPayload());
    apiSpy.getBillingInsights.and.resolveTo({} as unknown as BillingInsightsPayload);
    apiSpy.getBillingForecast.and.resolveTo({} as unknown as BillingForecastPayload);
    apiSpy.getBillingAlerts.and.resolveTo(buildAlertsPayload());

    TestBed.overrideComponent(BillingPage, {
      set: {
        template: ''
      }
    });

    await TestBed.configureTestingModule({
      imports: [BillingPage],
      providers: [
        { provide: ApiService, useValue: apiSpy },
        { provide: AuthService, useValue: authSpy }
      ]
    }).compileComponents();

    const fixture = TestBed.createComponent(BillingPage);
    component = fixture.componentInstance;
    await fixture.whenStable();
  });

  it('filters export history by format', () => {
    component.exportHistory.set([
      buildExportItem('a', 'json', 'json', 'success'),
      buildExportItem('b', 'excel', 'excel', 'success'),
      buildExportItem('c', 'excel', 'json', 'error')
    ]);

    component.setExportHistoryFilter('all');
    component.setExportHistoryFormatFilter('json');

    const rows = component.filteredExportHistory();
    expect(rows.length).toBe(2);
    expect(rows.map((row) => row.id)).toEqual(['a', 'c']);
  });

  it('moves selected exports to trash on delete confirmation', () => {
    component.exportHistory.set([
      buildExportItem('a', 'json', 'json', 'success'),
      buildExportItem('b', 'excel', 'excel', 'error')
    ]);
    component.selectedExportIds.set(new Set(['a']));

    component.confirmDeleteSelectedExports();

    expect(component.exportHistory().map((row) => row.id)).toEqual(['b']);
    expect(component.exportTrash().length).toBe(1);
    expect(component.exportTrash()[0].id).toBe('a');
  });

  it('restores one item from trash', () => {
    const trashItem = {
      ...buildExportItem('a', 'json', 'json', 'success'),
      deletedAt: new Date().toISOString()
    };
    component.exportTrash.set([trashItem]);
    component.exportHistory.set([]);

    component.restoreFromTrash(trashItem);

    expect(component.exportHistory().length).toBe(1);
    expect(component.exportHistory()[0].id).toBe('a');
    expect(component.exportTrash().length).toBe(0);
  });

  it('computes trend metrics from history and trash', () => {
    const now = Date.now();
    const today = new Date(now).toISOString();
    const twoDaysAgo = new Date(now - (2 * 24 * 60 * 60 * 1000)).toISOString();

    component.exportHistory.set([
      {
        ...buildExportItem('a', 'json', 'json', 'success'),
        createdAt: today
      },
      {
        ...buildExportItem('b', 'excel', 'excel', 'success'),
        createdAt: twoDaysAgo
      }
    ]);
    component.exportTrash.set([
      {
        ...buildExportItem('t', 'json', 'json', 'error'),
        deletedAt: new Date().toISOString()
      }
    ]);

    const trends = component.exportHistoryTrends();
    expect(trends.todayCount).toBeGreaterThanOrEqual(1);
    expect(trends.last7DaysCount).toBe(2);
    expect(trends.trashCount).toBe(1);
    expect(['CSV', 'JSON', 'Mixte']).toContain(trends.dominantFormat);
  });

  it('keeps only compatible deposit candidates for current deposit type', () => {
    component.depositType.set('cheque');
    component.depositCandidates.set([
      buildDepositCandidate('op1', 'Cheque'),
      buildDepositCandidate('op2', 'Especes')
    ]);

    expect(component.compatibleDepositCandidates().map((item) => item.operationId)).toEqual(['op1']);
  });

  it('blocks save in creation mode when wizard is not at recap step', async () => {
    component.editingDepositId.set(null);
    component.depositWizardStep.set(2);
    component.depositEditorCandidateIds.set(['op1']);
    component.depositCandidates.set([buildDepositCandidate('op1', 'Cheque')]);
    component.depositAmount.set('10');

    await component.saveDepositEditor();

    expect(component.errorMessage()).toContain('Finalisez le recapitulatif');
  });

  it('prunes incompatible selections when switching template type', () => {
    component.depositCandidates.set([
      buildDepositCandidate('op1', 'Cheque'),
      buildDepositCandidate('op2', 'Especes')
    ]);
    component.depositEditorCandidateIds.set(['op1', 'op2']);

    component.applyDepositTemplate('cheque');

    expect(component.depositEditorCandidateIds()).toEqual(['op1']);
  });
});

function buildOperationsPayload(): BillingOperationsPayload {
  return {
    operations: [],
    summary: [],
    stats: {
      debitCents: 0,
      creditCents: 0,
      netCents: 0,
      operationCount: 0
    },
    offices: [],
    users: [],
    selectedOwnerUserId: null,
    selectedOfficeId: null,
    from: '2026-01-01',
    to: '2026-01-31'
  };
}

function buildAlertsPayload(): BillingAlertsPayload {
  return {
    generatedAt: new Date().toISOString(),
    summary: {
      overdueCriticalCount: 0,
      dueSoonCount: 0,
      highExpensesCount: 0,
      unassignedOwnerCount: 0
    },
    overdueCritical: [],
    dueSoon: [],
    highExpenses: [],
    unassignedOwnerOperations: []
  };
}

function buildExportItem(
  id: string,
  operationsFormat: 'json' | 'excel',
  alertsFormat: 'json' | 'excel',
  status: 'success' | 'error'
): {
  id: string;
  sessionId: string;
  label: string;
  operationsFormat: 'json' | 'excel';
  alertsFormat: 'json' | 'excel';
  status: 'success' | 'error';
  createdAt: string;
} {
  return {
    id,
    sessionId: `SID-${id}`,
    label: `Export ${id}`,
    operationsFormat,
    alertsFormat,
    status,
    createdAt: new Date().toISOString()
  };
}

function buildDepositCandidate(operationId: string, paymentMethod: string): {
  operationId: string;
  sourceId: number;
  patientId: number | null;
  consultationId: number | null;
  occurredAt: string;
  patientName: string;
  invoiceNumber: string;
  amountCents: number;
  currency: string;
  paymentMethod: string;
  officeId: number | null;
} {
  return {
    operationId,
    sourceId: 1,
    patientId: 1,
    consultationId: 1,
    occurredAt: new Date().toISOString(),
    patientName: 'Patient Test',
    invoiceNumber: 'F-001',
    amountCents: 1000,
    currency: 'EUR',
    paymentMethod,
    officeId: null
  };
}

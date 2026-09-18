import { Component, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { ColumnDef, MASTER_CONFIG } from '../master/master.component';

export interface Toast { id: number; message: string; type: 'success' | 'error' | 'info'; }

export interface SyncResult {
  ok: boolean;
  message: string;
  elapsedSeconds?: number;
  mode?: 'all' | 'selected';
  requestedCount?: number;
  fetched?: number;
  mapped?: number;
  success: number;
  failed: number;
  failedList: string[];
  errorDetail?: any;
  isEmpty?: boolean;
}

export interface SyncCardConfig {
  key: string;               // matches /api/sync/:key path segment
  title: string;
  icon: string;
  desc: string;
  supportsSelection: boolean;
  masterType?: string;       // for GET /api/master/:masterType/list (products uses GET /api/products instead)
  recordKeyField?: string;
  columns?: ColumnDef[];
  hasDivisionFilter?: boolean;
  hasProductGroupFilter?: boolean;
  cronNote: string;
}

const PRODUCT_COLUMNS: ColumnDef[] = [
  { key: 'ProductCode', label: 'Product Code', cls: 'mono' },
  { key: 'ProductName', label: 'Product Name' },
  { key: 'Brand', label: 'Brand' },
  { key: 'DivisionCode', label: 'Division' },
  { key: 'ProductGroupCode', label: 'Product Group' },
];

export const SYNC_CONFIG: SyncCardConfig[] = [
  {
    key: 'products', title: 'Products', icon: '📦',
    desc: 'Sync product master data (SKUs, pricing attributes, HSN, brand) to Salesforce.',
    supportsSelection: true, recordKeyField: 'ProductCode', columns: PRODUCT_COLUMNS,
    hasDivisionFilter: true, hasProductGroupFilter: true,
    cronNote: 'Full catalog sync is manual only. Individual product changes also sync automatically at 12:30 AM daily.',
  },
  {
    key: 'pricelists', title: 'Price Lists', icon: '💰',
    desc: 'Sync state/brand-wise price list entries per product to Salesforce.',
    supportsSelection: true, masterType: 'pricelists',
    recordKeyField: MASTER_CONFIG['pricelists'].recordKeyField, columns: MASTER_CONFIG['pricelists'].columns,
    hasProductGroupFilter: true,
    cronNote: 'Also runs automatically every day at 1:00 AM.',
  },
  {
    key: 'images', title: 'Images', icon: '🖼️',
    desc: 'Upload product images to Salesforce.',
    supportsSelection: false,
    cronNote: 'Manual trigger only — not on any automatic schedule. Record selection is not supported for images.',
  },
  {
    key: 'schemes', title: 'Schemes', icon: '📝',
    desc: 'Sync promotion / scheme policies to Salesforce.',
    supportsSelection: true, masterType: 'schemes',
    recordKeyField: MASTER_CONFIG['schemes'].recordKeyField, columns: MASTER_CONFIG['schemes'].columns,
    cronNote: 'Manual trigger only — not on any automatic schedule.',
  },
  {
    key: 'businesspartners', title: 'Business Partners', icon: '👥',
    desc: 'Sync dealer/customer master data to Salesforce.',
    supportsSelection: true, masterType: 'businesspartners',
    recordKeyField: MASTER_CONFIG['businesspartners'].recordKeyField, columns: MASTER_CONFIG['businesspartners'].columns,
    cronNote: 'Full master sync is manual only. Individual BP changes also sync automatically at 2:00 AM daily.',
  },
  {
    key: 'stockInventory', title: 'Stock Inventory', icon: '📈',
    desc: 'Sync stock-on-hand quantities per product to Salesforce.',
    supportsSelection: true, masterType: 'stockInventory',
    recordKeyField: MASTER_CONFIG['stockInventory'].recordKeyField, columns: MASTER_CONFIG['stockInventory'].columns,
    cronNote: 'Also runs automatically every 5 hours.',
  },
  {
    key: 'outstanding', title: 'Outstanding', icon: '📋',
    desc: 'Sync outstanding / receivable balances per dealer to Salesforce.',
    supportsSelection: true, masterType: 'outstanding',
    recordKeyField: MASTER_CONFIG['outstanding'].recordKeyField, columns: MASTER_CONFIG['outstanding'].columns,
    cronNote: 'Manual trigger only — not on any automatic schedule.',
  },
];

function errStr(e: any): string {
  return typeof e === 'string' ? e : JSON.stringify(e);
}

function normalizeResult(raw: any, requestedCount?: number): SyncResult {
  const failedList: string[] = [];
  if (Array.isArray(raw.failedProducts)) failedList.push(...raw.failedProducts.map((c: any) => String(c)));
  if (Array.isArray(raw.failedDetails)) {
    for (const f of raw.failedDetails) {
      if (Array.isArray(f.codes) && f.codes.length) {
        failedList.push(...f.codes.map((c: any) => `${c}: ${errStr(f.error)}`));
      } else if (f.code) {
        failedList.push(`${f.code}: ${errStr(f.error)}`);
      } else if (f.policyNum || f.policyId) {
        failedList.push(`${f.policyNum ?? f.policyId}: ${errStr(f.error)}`);
      } else if (f.key) {
        failedList.push(`${f.key}: ${errStr(f.error)}`);
      } else {
        failedList.push(errStr(f.error ?? f));
      }
    }
  }

  const success = raw.totalSuccess ?? raw.successRecords ?? raw.successCount ?? 0;
  const failed  = raw.totalFailed ?? raw.failedRecords ?? raw.failedCount ?? failedList.length;
  const fetched = raw.totalDbRows ?? raw.dbRowsFetched;
  const mapped  = raw.totalMapped ?? raw.recordsSent ?? raw.imagesSent ?? raw.schemesMapped ?? raw.bpsMapped;
  const isEmpty = !raw.error && success === 0 && failed === 0 && fetched === undefined;

  return {
    ok: !raw.error && failed === 0,
    message: raw.message || (raw.error ? 'Sync failed' : 'Sync completed'),
    elapsedSeconds: raw.elapsedSeconds,
    mode: raw.mode,
    requestedCount: raw.requestedCount ?? requestedCount,
    fetched, mapped, success, failed, failedList,
    errorDetail: raw.error,
    isEmpty,
  };
}

@Component({
  selector: 'app-sync',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './sync.component.html',
  styleUrl: './sync.component.scss',
})
export class SyncComponent implements OnDestroy {
  cards = SYNC_CONFIG;

  syncing: Record<string, boolean> = {};
  results: Record<string, SyncResult | null> = {};
  expandedFailures: Record<string, boolean> = {};

  // Picker state
  pickerOpen = false;
  pickerCfg: SyncCardConfig | null = null;
  pickerRows: any[] = [];
  pickerTotal = 0;
  pickerTotalPages = 1;
  pickerPage = 1;
  pickerLimit = 50;
  pickerLoading = false;
  pickerSearch = '';
  pickerDivision = '';
  pickerGroup = '';
  pickerGroups: string[] = [];
  pickerSelected = new Set<string>();

  toasts: Toast[] = [];
  private toastId = 0;
  private pickerSearchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();

  constructor(private api: ApiService) {
    this.pickerSearchSubject.pipe(debounceTime(400), takeUntil(this.destroy$)).subscribe(() => {
      this.loadPickerPage(1);
    });
  }

  ngOnDestroy() {
    this.destroy$.next();
    this.destroy$.complete();
  }

  // ── Sync All / Sync Selected ────────────────────────────────────────────
  syncAll(cfg: SyncCardConfig) {
    this.runSync(cfg);
  }

  private runSync(cfg: SyncCardConfig, codes?: string[]) {
    if (this.syncing[cfg.key]) return;
    this.syncing[cfg.key] = true;
    this.expandedFailures[cfg.key] = false;
    this.showToast(`${cfg.title}: sync started${codes ? ` (${codes.length} selected)` : ''}…`, 'info');

    this.api.runSync(cfg.key, codes).subscribe({
      next: (raw) => {
        const result = normalizeResult(raw, codes?.length);
        this.results[cfg.key] = result;
        this.showToast(
          `${cfg.title}: ${result.message}`,
          result.ok ? 'success' : (result.failed > 0 ? 'error' : 'info'),
        );
      },
      error: (err) => {
        const message = err.error?.error || err.error?.message || err.message || 'Network error';
        this.results[cfg.key] = {
          ok: false, message: 'Sync request failed', success: 0,
          failed: codes?.length ?? 0, failedList: [], errorDetail: message,
        };
        this.showToast(`${cfg.title}: sync failed — ${message}`, 'error');
      },
      complete: () => { this.syncing[cfg.key] = false; },
    });
  }

  toggleFailures(key: string) {
    this.expandedFailures[key] = !this.expandedFailures[key];
  }

  // ── Picker ───────────────────────────────────────────────────────────────
  openPicker(cfg: SyncCardConfig) {
    this.pickerCfg = cfg;
    this.pickerOpen = true;
    this.pickerSearch = '';
    this.pickerDivision = '';
    this.pickerGroup = '';
    this.pickerGroups = [];
    this.pickerSelected.clear();
    if (cfg.hasProductGroupFilter) {
      this.api.getProductGroups().subscribe({
        next: (json) => { if (json.success) this.pickerGroups = json.data; },
        error: () => { /* dropdown stays empty */ },
      });
    }
    this.loadPickerPage(1);
  }

  closePicker() {
    this.pickerOpen = false;
    this.pickerCfg = null;
  }

  loadPickerPage(page: number) {
    if (!this.pickerCfg) return;
    this.pickerLoading = true;
    this.pickerPage = page;

    const params: Record<string, any> = { page, limit: this.pickerLimit };
    if (this.pickerSearch) params['search'] = this.pickerSearch;
    if (this.pickerCfg.hasDivisionFilter && this.pickerDivision) params['division'] = this.pickerDivision;
    if (this.pickerCfg.hasProductGroupFilter && this.pickerGroup) params['productGroup'] = this.pickerGroup;

    const obs = this.pickerCfg.key === 'products'
      ? this.api.getProducts(params)
      : this.api.getMasterList(this.pickerCfg.masterType!, params);

    obs.subscribe({
      next: (json) => {
        if (!json.success) { this.showToast('Load failed: ' + json.error, 'error'); return; }
        this.pickerRows = json.data;
        this.pickerTotal = json.total;
        this.pickerTotalPages = json.totalPages;
      },
      error: (err) => this.showToast('Error loading records: ' + err.message, 'error'),
      complete: () => { this.pickerLoading = false; },
    });
  }

  onPickerSearchInput() { this.pickerSearchSubject.next(this.pickerSearch); }
  onPickerFilterChange() { this.loadPickerPage(1); }

  pickerRowKey(row: any): string {
    return row[this.pickerCfg!.recordKeyField!];
  }

  isPickerRowSelected(row: any) { return this.pickerSelected.has(this.pickerRowKey(row)); }

  togglePickerRow(row: any, checked: boolean) {
    const key = this.pickerRowKey(row);
    if (checked) this.pickerSelected.add(key);
    else this.pickerSelected.delete(key);
  }

  isPickerPageFullySelected(): boolean {
    return this.pickerRows.length > 0 && this.pickerRows.every(r => this.pickerSelected.has(this.pickerRowKey(r)));
  }

  togglePickerSelectAll(checked: boolean) {
    for (const r of this.pickerRows) {
      const key = this.pickerRowKey(r);
      if (checked) this.pickerSelected.add(key);
      else this.pickerSelected.delete(key);
    }
  }

  goToPickerPage(page: number) {
    if (page < 1 || page > this.pickerTotalPages) return;
    this.loadPickerPage(page);
  }

  confirmPickerSync() {
    if (!this.pickerCfg) return;
    const codes = [...this.pickerSelected];
    if (!codes.length) { this.showToast('No records selected.', 'info'); return; }
    const cfg = this.pickerCfg;
    this.closePicker();
    this.runSync(cfg, codes);
  }

  cellValue(row: any, col: ColumnDef): string {
    const v = row[col.key];
    if (v === null || v === undefined || v === '') return '—';
    return col.fmt ? col.fmt(v) : String(v);
  }

  showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const id = ++this.toastId;
    this.toasts.push({ id, message, type });
    setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 5000);
  }
}

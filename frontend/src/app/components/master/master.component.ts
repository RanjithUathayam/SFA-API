import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute } from '@angular/router';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { GroupFilterComponent } from '../group-filter/group-filter.component';

export interface ColumnDef {
  key: string;
  label: string;
  cls?: string;
  align?: 'right';
  fmt?: (v: any) => string;
}

export interface MasterConfig {
  title: string;
  desc: string;
  icon: string;
  recordKeyField: string;
  columns: ColumnDef[];
  hasProductGroupFilter?: boolean;
  hasDateFilter?: boolean;     // From/To date inputs → fromDate/toDate query params
  previewable?: boolean;       // per-row "JSON" button → GET /api/master/:type/preview/:key
  docLabel?: string;           // document name shown with DocNum, e.g. "Invoice 1234"
}

function fmtNum(v: any): string {
  if (v == null) return '—';
  return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const MASTER_CONFIG: Record<string, MasterConfig> = {
  pricelists: {
    title: 'Price Lists', desc: 'View price records per product, track push status, sync to Salesforce.',
    icon: '💰', recordKeyField: 'ProductCode', hasProductGroupFilter: true,
    columns: [
      { key: 'ProductCode',      label: 'Product Code', cls: 'mono' },
      { key: 'ProductName',      label: 'Product Name' },
      { key: 'Brand',            label: 'Brand' },
      { key: 'ProductGroupCode', label: 'Product Group' },
      { key: 'PriceEntries',label: 'Entries', align: 'right' },
      { key: 'StateCount',  label: 'States',  align: 'right' },
      { key: 'MinPrice',    label: 'Min Price', align: 'right', fmt: fmtNum },
      { key: 'MaxPrice',    label: 'Max Price', align: 'right', fmt: fmtNum },
    ],
  },
  businesspartners: {
    title: 'Business Partners', desc: 'View dealer/customer master data and sync to Salesforce.',
    icon: '👥', recordKeyField: 'BPCode',
    columns: [
      { key: 'BPCode',     label: 'BP Code',   cls: 'mono' },
      { key: 'BPName',     label: 'BP Name' },
      { key: 'BPCategory', label: 'Category' },
      { key: 'AreaCode',   label: 'Area' },
      { key: 'GradeOfBP',  label: 'Grade' },
      { key: 'City',       label: 'City' },
      { key: 'GSTNo',      label: 'GST No', cls: 'mono' },
      { key: 'Phone1',     label: 'Phone',  cls: 'mono' },
    ],
  },
  schemes: {
    title: 'Schemes / Promotions', desc: 'View scheme policies and sync to Salesforce.',
    icon: '📝', recordKeyField: 'DocEntry',
    columns: [
      { key: 'PolicyNumber',  label: 'Policy No',      cls: 'mono' },
      { key: 'PolicyName',    label: 'Scheme Name' },
      { key: 'DivisionCode',  label: 'Division' },
      { key: 'DiscountBasis', label: 'Discount Basis' },
      { key: 'FromDate',      label: 'From' },
      { key: 'ToDate',        label: 'To' },
      { key: 'LineCount',     label: 'Lines', align: 'right' },
    ],
  },
  stockInventory: {
    title: 'Stock Inventory', desc: 'View stock levels per product and sync to Salesforce.',
    icon: '📈', recordKeyField: 'ProductCode',
    columns: [
      { key: 'ProductCode',   label: 'Product Code', cls: 'mono' },
      { key: 'ProductName',   label: 'Product Name' },
      { key: 'Brand',         label: 'Brand' },
      { key: 'StyleCode',     label: 'Style' },
      { key: 'StockQuantity', label: 'Stock Qty', align: 'right' },
    ],
  },
  outstanding: {
    title: 'Outstanding / Receivables', desc: 'View outstanding balances per dealer and sync to Salesforce.',
    icon: '📋', recordKeyField: 'CardCode',
    columns: [
      { key: 'CardCode',       label: 'Card Code',       cls: 'mono' },
      { key: 'CardName',       label: 'Name' },
      { key: 'DivisionCode',   label: 'Division' },
      { key: 'City',           label: 'City' },
      { key: 'InvoiceCount',   label: 'Invoices',        align: 'right' },
      { key: 'TotalBalance',   label: 'Total Balance',   align: 'right', fmt: fmtNum },
      { key: 'MaxOverdueDays', label: 'Max Overdue Days',align: 'right' },
    ],
  },
  invoice: {
    title: 'AR Invoices', desc: 'View SAP A/R invoices for dealer customers by date, track push status, and push to Salesforce InvoiceAPI.',
    icon: '🧾', recordKeyField: 'DocEntry', hasDateFilter: true, previewable: true, docLabel: 'Invoice',
    columns: [
      { key: 'DocNum',        label: 'Invoice No', cls: 'mono' },
      { key: 'DocDate',       label: 'Date' },
      { key: 'CardCode',      label: 'Card Code',  cls: 'mono' },
      { key: 'CardName',      label: 'Customer' },
      { key: 'Brand',         label: 'Brand' },
      { key: 'DivisionName',  label: 'Division' },
      { key: 'LineCount',     label: 'Lines',      align: 'right' },
      { key: 'TotalQuantity', label: 'Qty',        align: 'right' },
      { key: 'DocTotal',      label: 'Doc Total',  align: 'right', fmt: fmtNum },
    ],
  },
  salereturn: {
    title: 'Sale Returns', desc: 'View SAP A/R credit memos (sale returns) by date, track push status, and push to Salesforce SaleReturnAPI.',
    icon: '↩️', recordKeyField: 'DocEntry', hasDateFilter: true, previewable: true, docLabel: 'Sale Return',
    columns: [
      { key: 'DocNum',        label: 'Return No',     cls: 'mono' },
      { key: 'DocDate',       label: 'Date' },
      { key: 'CardCode',      label: 'Card Code',     cls: 'mono' },
      { key: 'CardName',      label: 'Customer' },
      { key: 'CustomerType',  label: 'Cust. Type' },
      { key: 'DivisionCode',  label: 'Division' },
      { key: 'LineCount',     label: 'Lines',         align: 'right' },
      { key: 'TotalQuantity', label: 'Qty',           align: 'right' },
      { key: 'DocTotal',      label: 'Total Amount',  align: 'right', fmt: fmtNum },
      { key: 'Remarks',       label: 'Remarks' },
    ],
  },
};

interface Summary { Pending?: number; Pushing?: number; Pushed?: number; Failed?: number; }
interface Toast    { id: number; message: string; type: 'success'|'error'|'info'; }
interface Preview  { key: string; label: string; loading: boolean; json?: string; error?: string; }
interface PushResult {
  successCount?: number; failedCount?: number; totalRequested?: number;
  failedRecords?: Array<{ key: string; error: any }>;
}

@Component({
  selector: 'app-master',
  imports: [CommonModule, FormsModule, GroupFilterComponent],
  templateUrl: './master.component.html',
  styleUrl: './master.component.scss',
})
export class MasterComponent implements OnInit, OnDestroy {
  masterType = 'pricelists';
  cfg: MasterConfig = MASTER_CONFIG['pricelists'];

  records: any[] = [];
  summary: Summary = {};
  totalRecords = 0;
  totalPages = 1;
  currentPage = 1;
  pageLimit = 50;
  loading = false;

  searchInput = '';
  statusFilter = '';
  productGroupFilter = '';
  productGroups: string[] = [];
  fromDate = '';
  toDate = '';

  preview: Preview | null = null;

  selectedKeys = new Set<string>();
  pushingKeys  = new Set<string>();

  resultPanel: PushResult | null = null;
  showResultPanel = false;
  toasts: Toast[] = [];
  private toastId = 0;

  private pollTimer?: ReturnType<typeof setTimeout>;
  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();

  constructor(private route: ActivatedRoute, private api: ApiService) {}

  ngOnInit() {
    this.route.paramMap.pipe(takeUntil(this.destroy$)).subscribe(params => {
      const type = params.get('type') || 'pricelists';
      this.masterType = type;
      this.cfg = MASTER_CONFIG[type] || MASTER_CONFIG['pricelists'];
      this.resetState();
      this.loadPage(1);
      if (this.cfg.hasProductGroupFilter) this.loadProductGroups();
    });

    this.searchSubject.pipe(debounceTime(400), takeUntil(this.destroy$)).subscribe(() => {
      this.currentPage = 1;
      this.loadPage(1);
    });
  }

  ngOnDestroy() {
    clearTimeout(this.pollTimer);
    this.destroy$.next();
    this.destroy$.complete();
  }

  private resetState() {
    this.records = []; this.summary = {}; this.totalRecords = 0; this.totalPages = 1;
    this.currentPage = 1; this.searchInput = ''; this.statusFilter = ''; this.productGroupFilter = '';
    this.fromDate = ''; this.toDate = ''; this.preview = null;
    this.selectedKeys.clear(); this.pushingKeys.clear();
    this.showResultPanel = false; this.resultPanel = null;
    clearTimeout(this.pollTimer);
  }

  loadProductGroups() {
    this.api.getProductGroups().subscribe({
      next: (json) => { if (json.success) this.productGroups = json.data; },
      error: () => { /* dropdown just stays empty if this fails */ },
    });
  }

  onProductGroupChange(group: string) {
    this.productGroupFilter = group;
    this.loadPage(1);
  }

  loadPage(page: number) {
    this.currentPage = page;
    this.loading = true;
    clearTimeout(this.pollTimer);

    const params: Record<string, any> = { page: this.currentPage, limit: this.pageLimit };
    if (this.searchInput)        params['search']       = this.searchInput;
    if (this.statusFilter)       params['pushStatus']    = this.statusFilter;
    if (this.productGroupFilter) params['productGroup']  = this.productGroupFilter;
    if (this.cfg.hasDateFilter && this.fromDate) params['fromDate'] = this.fromDate;
    if (this.cfg.hasDateFilter && this.toDate)   params['toDate']   = this.toDate;

    this.api.getMasterList(this.masterType, params).subscribe({
      next: (data) => {
        if (!data.success) { this.showToast('Error: ' + data.error, 'error'); return; }
        this.records     = data.data;
        this.totalPages  = data.totalPages;
        this.totalRecords = data.total;
        this.summary      = data.summary || {};
        // Show the server's default window (SF_INVOICE_SYNC_FROM_DATE → today) in the date inputs
        if (data.window) {
          if (!this.fromDate) this.fromDate = data.window.fromDate;
          if (!this.toDate)   this.toDate   = data.window.toDate;
        }

        this.records.forEach(r => {
          const key = String(r[this.cfg.recordKeyField]);
          if (r.PushStatus === 'Pushing') this.pushingKeys.add(key);
          else this.pushingKeys.delete(key);
        });

        const hasPushing = this.pushingKeys.size > 0;
        this.pollTimer = setTimeout(() => this.loadPage(this.currentPage), hasPushing ? 3500 : 30000);
      },
      error: (err) => this.showToast('Network error: ' + err.message, 'error'),
      complete: () => { this.loading = false; },
    });
  }

  onSearchInput() { this.searchSubject.next(this.searchInput); }

  filterByStatus(status: string) {
    this.statusFilter = status;
    this.loadPage(1);
  }

  onPageLimitChange() { this.loadPage(1); }

  onDateChange() {
    if (this.fromDate && this.toDate && this.fromDate > this.toDate) {
      this.showToast('From date must be on or before To date.', 'error');
      return;
    }
    this.selectedKeys.clear();
    this.loadPage(1);
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.selectedKeys.clear();
    this.loadPage(page);
  }

  getKey(row: any): string { return String(row[this.cfg.recordKeyField]); }

  getCellValue(row: any, col: ColumnDef): string {
    const v = row[col.key];
    if (col.fmt) return col.fmt(v);
    return v != null ? String(v) : '—';
  }

  isKeyPushing(key: string) { return this.pushingKeys.has(key); }
  isKeySelected(key: string) { return this.selectedKeys.has(key); }

  toggleRow(key: string, checked: boolean) {
    if (checked) this.selectedKeys.add(key);
    else         this.selectedKeys.delete(key);
  }

  toggleAll(checked: boolean) {
    this.records.forEach(r => {
      const key = this.getKey(r);
      if (checked) this.selectedKeys.add(key);
      else         this.selectedKeys.delete(key);
    });
  }

  clearSelection() { this.selectedKeys.clear(); }

  get selectionCount() { return this.selectedKeys.size; }

  isAllSelected(): boolean {
    return this.records.length > 0 && this.records.every(r => this.selectedKeys.has(this.getKey(r)));
  }

  pushSingle(key: string) {
    this.pushingKeys.add(key);
    this.showToast(`Pushing ${key}…`, 'info');
    this.api.pushMaster(this.masterType, [key]).subscribe({
      next: (data) => {
        this.pushingKeys.delete(key);
        this.showResult(data);
        this.loadPage(this.currentPage);
      },
      error: (err) => {
        this.pushingKeys.delete(key);
        this.showToast('Push failed: ' + err.message, 'error');
      },
    });
  }

  pushSelected() {
    const keys = [...this.selectedKeys];
    if (!keys.length) return;
    this.clearSelection();
    keys.forEach(k => this.pushingKeys.add(k));
    this.showToast(`Pushing ${keys.length} record(s)…`, 'info');
    this.api.pushMaster(this.masterType, keys).subscribe({
      next: (data) => {
        keys.forEach(k => this.pushingKeys.delete(k));
        this.showResult(data);
        this.loadPage(this.currentPage);
      },
      error: (err) => {
        keys.forEach(k => this.pushingKeys.delete(k));
        this.showToast('Push failed: ' + err.message, 'error');
      },
    });
  }

  pushAll() {
    if (!confirm(`Push ALL ${this.cfg.title} matching the current filter?\n\nThis runs in the background.`)) return;
    this.loading = true;
    const body: Record<string, any> = {};
    if (this.searchInput)        body['search']       = this.searchInput;
    if (this.statusFilter)       body['pushStatus']    = this.statusFilter;
    if (this.productGroupFilter) body['productGroup']  = this.productGroupFilter;
    if (this.cfg.hasDateFilter && this.fromDate) body['fromDate'] = this.fromDate;
    if (this.cfg.hasDateFilter && this.toDate)   body['toDate']   = this.toDate;

    this.api.pushAllMaster(this.masterType, body).subscribe({
      next: (data) => {
        if (data.success) {
          this.showToast('Push-All started in background. Refreshing…', 'info');
          setTimeout(() => this.loadPage(1), 1500);
        } else {
          this.showToast('Error: ' + data.error, 'error');
        }
      },
      error: (err) => this.showToast('Push-All failed: ' + err.message, 'error'),
      complete: () => { this.loading = false; },
    });
  }

  openPreview(row: any) {
    const key = this.getKey(row);
    const label = row.DocNum != null ? `${this.cfg.docLabel ?? 'Doc'} ${row.DocNum}` : key;
    this.preview = { key, label, loading: true };
    this.api.previewMaster(this.masterType, key).subscribe({
      next: (data) => {
        if (this.preview?.key !== key) return;
        this.preview = data.success
          ? { key, label, loading: false, json: JSON.stringify(data.payload, null, 2) }
          : { key, label, loading: false, error: data.error };
      },
      error: (err) => {
        if (this.preview?.key !== key) return;
        this.preview = { key, label, loading: false, error: err.error?.error || err.message };
      },
    });
  }

  closePreview() { this.preview = null; }

  copyPreview() {
    if (!this.preview?.json) return;
    navigator.clipboard.writeText(this.preview.json).then(
      () => this.showToast('Payload copied to clipboard.', 'success'),
      () => this.showToast('Copy failed — select the text and copy manually.', 'error'),
    );
  }

  pushFromPreview() {
    if (!this.preview) return;
    const key = this.preview.key;
    this.closePreview();
    this.pushSingle(key);
  }

  showResult(data: any) {
    this.resultPanel = data;
    this.showResultPanel = true;
  }

  closeResultPanel() { this.showResultPanel = false; }

  getPageNumbers(): (number | string)[] {
    const delta = 2;
    const pages: number[] = [];
    for (let i = Math.max(1, this.currentPage - delta); i <= Math.min(this.totalPages, this.currentPage + delta); i++) pages.push(i);
    if (pages[0] > 1) pages.unshift(1);
    if (pages[pages.length - 1] < this.totalPages) pages.push(this.totalPages);

    const result: (number | string)[] = [];
    let prev = 0;
    for (const p of pages) {
      if (prev && p - prev > 1) result.push('…');
      result.push(p);
      prev = p;
    }
    return result;
  }

  fmtDate(dt: string): string {
    return new Date(dt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  errStr(e: any): string { return typeof e === 'string' ? e : JSON.stringify(e); }

  showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const id = ++this.toastId;
    this.toasts.push({ id, message, type });
    setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 4000);
  }
}

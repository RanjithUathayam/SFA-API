import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subject } from 'rxjs';
import { debounceTime, takeUntil } from 'rxjs/operators';
import { ApiService } from '../../services/api.service';
import { GroupFilterComponent } from '../group-filter/group-filter.component';

interface PriceRow {
  ProductCode: string;
  ProductName: string;
  Brand: string;
  ProductGroupCode: string;
  PriceListID: number;
  SubBrandCode: string;
  Price: number;
  MRP: number;
  PriceID: number;
  PriceListIsActive: number;
  PushStatus?: string;
  LastPushedAt?: string;
  PushError?: string;
}

interface Toast { id: number; message: string; type: 'success' | 'error' | 'info'; }
interface PushResult {
  success?: boolean; successCount?: number; failedCount?: number; totalRequested?: number;
  failedRecords?: Array<{ key: string; error: any }>;
}

const SORTABLE_COLUMNS = ['ProductCode', 'ProductName', 'Price', 'MRP', 'SubBrandCode'] as const;
type SortColumn = typeof SORTABLE_COLUMNS[number];

@Component({
  selector: 'app-price-list',
  standalone: true,
  imports: [CommonModule, FormsModule, GroupFilterComponent],
  templateUrl: './price-list.component.html',
  styleUrl: './price-list.component.scss',
})
export class PriceListComponent implements OnInit, OnDestroy {
  rows: PriceRow[] = [];
  total = 0;
  totalPages = 1;
  currentPage = 1;
  pageLimit = 50;
  loading = false;

  searchInput = '';
  productGroupFilter = '';
  productGroups: string[] = [];
  subBrandFilter = '';
  states: string[] = [];
  activeOnly = false;

  sortBy: SortColumn = 'ProductCode';
  sortDir: 'ASC' | 'DESC' = 'ASC';

  selectedKeys = new Set<string>();
  pushingProducts = new Set<string>();

  resultPanel: PushResult | null = null;
  showResultPanel = false;
  toasts: Toast[] = [];
  private toastId = 0;

  private pollTimer?: ReturnType<typeof setTimeout>;
  private searchSubject = new Subject<string>();
  private destroy$ = new Subject<void>();

  constructor(private api: ApiService) {}

  ngOnInit() {
    this.loadProductGroups();
    this.loadStates();
    this.loadPage(1);
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

  loadProductGroups() {
    this.api.getProductGroups().subscribe({
      next: (json) => { if (json.success) this.productGroups = json.data; },
      error: () => { /* dropdown just stays empty if this fails */ },
    });
  }

  loadStates() {
    this.api.getPriceListStates().subscribe({
      next: (json) => { if (json.success) this.states = json.data; },
      error: () => { /* dropdown just stays empty if this fails */ },
    });
  }

  loadPage(page: number) {
    this.currentPage = page;
    this.loading = true;
    clearTimeout(this.pollTimer);

    const params: Record<string, any> = {
      page: this.currentPage, limit: this.pageLimit,
      sortBy: this.sortBy, sortDir: this.sortDir,
    };
    if (this.searchInput)        params['search']       = this.searchInput;
    if (this.productGroupFilter) params['productGroup'] = this.productGroupFilter;
    if (this.subBrandFilter)     params['subBrand']     = this.subBrandFilter;
    if (this.activeOnly)         params['activeOnly']   = 'true';

    this.api.getPriceListRows(params).subscribe({
      next: (json) => {
        if (!json.success) { this.showToast('Load failed: ' + json.error, 'error'); return; }
        this.rows       = json.data;
        this.total      = json.total;
        this.totalPages = json.totalPages;

        this.rows.filter(r => r.PushStatus === 'Pushing').forEach(r => this.pushingProducts.add(r.ProductCode));
        if (this.pushingProducts.size > 0) {
          this.pollTimer = setTimeout(() => this.loadPage(this.currentPage), 3500);
        }
      },
      error: (err) => this.showToast('Network error: ' + err.message, 'error'),
      complete: () => { this.loading = false; },
    });
  }

  onSearchInput() { this.searchSubject.next(this.searchInput); }
  onFilterChange() { this.currentPage = 1; this.loadPage(1); }
  onProductGroupChange(group: string) { this.productGroupFilter = group; this.currentPage = 1; this.loadPage(1); }
  onPageLimitChange() { this.loadPage(1); }

  sortByCol(col: SortColumn) {
    if (this.sortBy === col) {
      this.sortDir = this.sortDir === 'ASC' ? 'DESC' : 'ASC';
    } else {
      this.sortBy = col;
      this.sortDir = 'ASC';
    }
    this.loadPage(1);
  }

  sortIndicator(col: SortColumn): string {
    if (this.sortBy !== col) return '';
    return this.sortDir === 'ASC' ? ' ▲' : ' ▼';
  }

  goToPage(page: number) {
    if (page < 1 || page > this.totalPages) return;
    this.loadPage(page);
  }

  rowKey(row: PriceRow): string { return `${row.ProductCode}::${row.SubBrandCode}`; }
  isRowSelected(row: PriceRow) { return this.selectedKeys.has(this.rowKey(row)); }

  toggleRow(row: PriceRow, checked: boolean) {
    const key = this.rowKey(row);
    if (checked) this.selectedKeys.add(key);
    else this.selectedKeys.delete(key);
  }

  isAllSelected(): boolean {
    return this.rows.length > 0 && this.rows.every(r => this.selectedKeys.has(this.rowKey(r)));
  }

  toggleAll(checked: boolean) {
    this.rows.forEach(r => {
      const key = this.rowKey(r);
      if (checked) this.selectedKeys.add(key);
      else this.selectedKeys.delete(key);
    });
  }

  clearSelection() { this.selectedKeys.clear(); }

  get selectedProductCodes(): string[] {
    const codes = new Set<string>();
    for (const row of this.rows) {
      if (this.selectedKeys.has(this.rowKey(row))) codes.add(row.ProductCode);
    }
    return [...codes];
  }

  get selectionCount() { return this.selectedProductCodes.length; }

  isProductPushing(code: string) { return this.pushingProducts.has(code); }

  pushSingle(row: PriceRow) { this.doPush([row.ProductCode]); }

  pushSelected() {
    const codes = this.selectedProductCodes;
    if (!codes.length) { this.showToast('No products selected.', 'info'); return; }
    this.clearSelection();
    this.doPush(codes);
  }

  doPush(codes: string[]) {
    codes.forEach(c => this.pushingProducts.add(c));
    this.showToast(`Pushing ${codes.length} product(s)…`, 'info');

    this.api.pushMaster('pricelists', codes).subscribe({
      next: (result) => {
        codes.forEach(c => this.pushingProducts.delete(c));
        this.resultPanel = result;
        this.showResultPanel = true;
        const s = result.successCount ?? 0;
        const f = result.failedCount ?? 0;
        this.showToast(`Push done — ${s} succeeded, ${f} failed.`, result.success ? 'success' : 'error');
        this.loadPage(this.currentPage);
      },
      error: (err) => {
        codes.forEach(c => this.pushingProducts.delete(c));
        this.showToast('Push error: ' + err.message, 'error');
        this.loadPage(this.currentPage);
      },
    });
  }

  pushAllMatching() {
    if (!confirm(
      'Push ALL price list products matching the current SEARCH and PRODUCT GROUP filters?\n\n' +
      '(State and "Active only" are view-only filters — Push All is scoped by search/group and pushes every state for each matched product.)\n\n' +
      'This runs in the background.'
    )) return;

    const body: Record<string, any> = {};
    if (this.searchInput)        body['search']       = this.searchInput;
    if (this.productGroupFilter) body['productGroup'] = this.productGroupFilter;

    this.loading = true;
    this.api.pushAllMaster('pricelists', body).subscribe({
      next: (json) => {
        if (json.success) {
          this.showToast('Push-All started in background. Refreshing…', 'info');
          setTimeout(() => this.loadPage(1), 1500);
        } else {
          this.showToast('Error: ' + json.error, 'error');
        }
      },
      error: (err) => this.showToast('Push-All failed: ' + err.message, 'error'),
      complete: () => { this.loading = false; },
    });
  }

  closeResultPanel() { this.showResultPanel = false; }

  fmtPrice(v: number | null | undefined): string {
    if (v == null) return '—';
    return Number(v).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  fmtDate(dt?: string): string {
    if (!dt) return '—';
    return new Date(dt).toLocaleString('en-IN', {
      day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  }

  errStr(e: any): string { return typeof e === 'string' ? e : JSON.stringify(e); }

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

  showToast(message: string, type: 'success' | 'error' | 'info' = 'info') {
    const id = ++this.toastId;
    this.toasts.push({ id, message, type });
    setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 5000);
  }
}

import { Component, ElementRef, EventEmitter, HostListener, Input, Output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-group-filter',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './group-filter.component.html',
  styleUrl: './group-filter.component.scss',
})
export class GroupFilterComponent {
  @Input() options: string[] = [];
  @Input() value = '';
  @Input() placeholder = 'All Product Groups';
  @Output() valueChange = new EventEmitter<string>();

  isOpen = false;
  searchText = '';

  constructor(private elRef: ElementRef<HTMLElement>) {}

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent) {
    if (!this.elRef.nativeElement.contains(e.target as Node)) {
      this.isOpen = false;
    }
  }

  onFocus() {
    this.isOpen = true;
    this.searchText = '';
  }

  onInput(e: Event) {
    this.searchText = (e.target as HTMLInputElement).value;
  }

  filteredOptions(): string[] {
    const q = this.searchText.trim().toLowerCase();
    if (!q) return this.options;
    return this.options.filter(o => o.toLowerCase().includes(q));
  }

  select(opt: string) {
    this.value = opt;
    this.valueChange.emit(opt);
    this.isOpen = false;
    this.searchText = '';
  }

  clear(e: Event) {
    e.stopPropagation();
    this.select('');
  }
}

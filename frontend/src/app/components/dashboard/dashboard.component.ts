import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface ModuleCard {
  icon: string;
  title: string;
  desc: string;
  link: string;
  queryParams?: Record<string, string>;
}

@Component({
  selector: 'app-dashboard',
  imports: [RouterLink],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.scss',
})
export class DashboardComponent {
  cards: ModuleCard[] = [
    {
      icon: '📦',
      title: 'Product Master',
      desc: 'View all products, track push status per record, push single or in bulk to Salesforce.',
      link: '/products',
    },
    {
      icon: '💰',
      title: 'Price Lists',
      desc: 'State-wise dealer pricing per product, sourced directly from SAP — search, filter, and push to Salesforce.',
      link: '/pricelist',
    },
    {
      icon: '👥',
      title: 'Business Partners',
      desc: 'View and push dealer/customer master data with individual push tracking.',
      link: '/master/businesspartners',
    },
    {
      icon: '📝',
      title: 'Schemes / Promotions',
      desc: 'Track promotion scheme push status per scheme policy.',
      link: '/master/schemes',
    },
    {
      icon: '📈',
      title: 'Stock Inventory',
      desc: 'Push stock levels per product/warehouse to Salesforce.',
      link: '/master/stockInventory',
    },
    {
      icon: '📋',
      title: 'Outstanding / Receivables',
      desc: 'Push outstanding invoice data per dealer to Salesforce.',
      link: '/master/outstanding',
    },
    {
      icon: '👨‍💼',
      title: 'E-HR Attendance',
      desc: 'Monitor attendance punch logs and manually trigger SF→DB sync and DB→EHR API push.',
      link: '/ehr',
    },
    {
      icon: '🔄',
      title: 'Sync Center',
      desc: 'Trigger bulk Salesforce sync for products, price lists, images, schemes, BPs, stock and outstanding — sync all or select specific records.',
      link: '/sync',
    },
  ];
}

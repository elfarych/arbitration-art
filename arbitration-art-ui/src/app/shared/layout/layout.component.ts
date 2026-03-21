import { ChangeDetectionStrategy, Component, inject, OnInit } from '@angular/core';
import { RouterLink, RouterOutlet } from '@angular/router';
import { UpperCasePipe } from '@angular/common';

import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-layout',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [RouterOutlet, RouterLink, UpperCasePipe],
  templateUrl: './layout.component.html',
  styleUrl: './layout.component.scss',
})
export class LayoutComponent implements OnInit {
  protected readonly auth = inject(AuthService);

  ngOnInit(): void {
    if (!this.auth.user()) {
      this.auth.fetchUser().subscribe();
    }
  }
}

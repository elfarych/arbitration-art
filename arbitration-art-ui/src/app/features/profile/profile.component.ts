import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { UpperCasePipe, DatePipe } from '@angular/common';
import { TuiButton } from '@taiga-ui/core';

import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-profile',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [UpperCasePipe, DatePipe, TuiButton],
  templateUrl: './profile.component.html',
  styleUrl: './profile.component.scss',
})
export class ProfileComponent implements OnInit {
  protected readonly auth = inject(AuthService);
  protected readonly loading = signal(true);

  ngOnInit(): void {
    this.auth.fetchUser().subscribe({
      next: () => this.loading.set(false),
      error: () => this.loading.set(false),
    });
  }

  logout(): void {
    this.auth.logout();
  }
}

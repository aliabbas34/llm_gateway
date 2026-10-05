/**
 * Instance lifecycle state shared by the readiness probe and the request pipeline.
 * Once draining starts it never stops: a draining instance is on its way out.
 */
export class Lifecycle {
  private draining = false;

  startDraining(): void {
    this.draining = true;
  }

  isDraining(): boolean {
    return this.draining;
  }
}

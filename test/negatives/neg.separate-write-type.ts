export class Thing {
  private _size = 0;

  public get size(): number {
      return this._size;
  }

  public set size(value: string | number | boolean) {
      let num = Number(value);

      // Don't allow NaN and stuff.
      if (!Number.isFinite(num)) {
          this._size = 0;
          return;
      }

      this._size = num;
  }
}

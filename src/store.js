export class MemoryStore {
  constructor(initialState) {
    this.state = structuredClone(initialState);
  }

  read() {
    return this.state;
  }

  update(mutator) {
    return mutator(this.state);
  }
}

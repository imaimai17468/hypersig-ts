export interface Todo {
  readonly key: string;
  readonly title: string;
  readonly completed: boolean;
}

export const filters = ["all", "active", "completed"] as const;
export type Filter = (typeof filters)[number];
export type Partition = Exclude<Filter, "all">;

export type TodoAction =
  | { kind: "add"; key: string; title: string }
  | { kind: "edit"; key: string; title: string }
  | { kind: "remove"; key: string }
  | { kind: "set-completed"; key: string; completed: boolean }
  | { kind: "set-all-completed"; completed: boolean }
  | { kind: "clear-completed" };

export function selectTodos(
  todos: readonly Todo[],
  filter: Filter
): readonly Todo[] {
  if (filter === "all") return todos;
  return todos.filter((todo) => todo.completed === (filter === "completed"));
}

export function applyTodoAction(
  todos: readonly Todo[],
  action: TodoAction
): readonly Todo[] {
  switch (action.kind) {
    case "add":
      return [
        ...todos,
        { key: action.key, title: action.title, completed: false },
      ];
    case "edit":
      return todos.map((todo) =>
        todo.key === action.key && todo.title !== action.title
          ? { ...todo, title: action.title }
          : todo
      );
    case "remove":
      return todos.filter((todo) => todo.key !== action.key);
    case "set-completed":
      return todos.map((todo) =>
        todo.key === action.key && todo.completed !== action.completed
          ? { ...todo, completed: action.completed }
          : todo
      );
    case "set-all-completed":
      return todos.map((todo) =>
        todo.completed === action.completed
          ? todo
          : { ...todo, completed: action.completed }
      );
    case "clear-completed":
      return selectTodos(todos, "active");
  }
}

export function compareTodos(before: readonly Todo[], after: readonly Todo[]) {
  const partitions: readonly Partition[] = ["active", "completed"];
  const changed: Partition[] = [];
  let countsChanged = false;
  for (const partition of partitions) {
    const oldTodos = selectTodos(before, partition);
    const newTodos = selectTodos(after, partition);
    if (oldTodos.length !== newTodos.length) countsChanged = true;
    if (
      oldTodos.length !== newTodos.length ||
      oldTodos.some((todo, index) => todo !== newTodos[index])
    ) {
      changed.push(partition);
    }
  }
  return { partitions: changed, countsChanged };
}

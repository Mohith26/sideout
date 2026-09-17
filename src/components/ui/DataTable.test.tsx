// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";

interface Row {
  id: string;
  team: string;
  wins: number;
}

const columns: DataTableColumn<Row>[] = [
  { key: "team", header: "Team", render: (r) => r.team },
  { key: "wins", header: "Wins", numeric: true, render: (r) => r.wins },
];

describe("DataTable", () => {
  it("renders a real table with headers, tabular numeric cells, and a caption", () => {
    render(
      <DataTable
        columns={columns}
        rows={[
          { id: "1", team: "Delgado / Okafor", wins: 3 },
          { id: "2", team: "Raman / Whitfield", wins: 1 },
        ]}
        getRowKey={(r) => r.id}
        caption="Pool A"
      />,
    );
    expect(screen.getByRole("table", { name: "Pool A" })).toBeInTheDocument();
    expect(screen.getAllByRole("columnheader")).toHaveLength(2);
    expect(screen.getAllByRole("row")).toHaveLength(3);
    const cell = screen.getByText("3").closest("td");
    expect(cell?.className).toContain("tabular");
    expect(cell?.className).toContain("text-end");
  });

  it("shows the empty label when there are no rows", () => {
    render(<DataTable columns={columns} rows={[]} getRowKey={(r) => r.id} emptyLabel="No results yet" />);
    expect(screen.getByText("No results yet")).toBeInTheDocument();
  });
});

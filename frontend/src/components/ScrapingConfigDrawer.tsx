import { useEffect, useMemo, useState, type FormEvent } from "react";

import { api } from "../lib/api";
import type {
  CarModelGroup,
  ScrapeSource,
  ScrapeTarget,
  ScrapeTargetSelection,
} from "../types";
import { Banner, Drawer, Empty, Loading } from "./ui";

const pairKey = (sourceId: number, modelKey: string) => `${sourceId}:${modelKey}`;

export function ScrapingConfigDrawer({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [sources, setSources] = useState<ScrapeSource[]>([]);
  const [groups, setGroups] = useState<CarModelGroup[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [maxPerTarget, setMaxPerTarget] = useState(15);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    Promise.all([
      api.get<ScrapeSource[]>("/scraping/sources"),
      api.get<ScrapeTarget[]>("/scraping/targets"),
      api.get<CarModelGroup[]>("/car-models/groups"),
    ])
      .then(([nextSources, targets, nextGroups]) => {
        if (!active) return;
        setSources(nextSources);
        setGroups(nextGroups);
        setSelected(
          new Set(targets.map((target) => pairKey(target.source_id, target.make_model_key))),
        );
        if (targets[0]) setMaxPerTarget(targets[0].max_results);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (!active) return;
        setError(reason instanceof Error ? reason.message : "No se pudo cargar el rastreo");
        setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleGroups = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("es");
    if (!needle) return groups;
    return groups.filter((group) => group.label.toLocaleLowerCase("es").includes(needle));
  }, [groups, search]);

  const selectedCount = selected.size;

  function toggle(sourceId: number, modelKey: string) {
    const key = pairKey(sourceId, modelKey);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function toggleRow(group: CarModelGroup) {
    const keys = sources.map((source) => pairKey(source.id, group.key));
    const allSelected = keys.every((key) => selected.has(key));
    setSelected((current) => {
      const next = new Set(current);
      for (const key of keys) {
        if (allSelected) next.delete(key);
        else next.add(key);
      }
      return next;
    });
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);

    const targets: ScrapeTargetSelection[] = [];
    for (const group of groups) {
      for (const source of sources) {
        if (!selected.has(pairKey(source.id, group.key))) continue;
        targets.push({
          source_id: source.id,
          make: group.make,
          model: group.model,
        });
      }
    }

    try {
      await api.put("/scraping/targets", {
        max_per_target: maxPerTarget,
        targets,
      });
      onSaved();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "No se pudo guardar el rastreo");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Drawer
      title="Configurar captación"
      subtitle={`${selectedCount} combinaciones activas · configuración global`}
      onClose={onClose}
      wide
    >
      {error ? <Banner kind="error">{error}</Banner> : null}

      {loading ? (
        <Loading label="Cargando modelos y fuentes…" />
      ) : (
        <form className="scrape-config" onSubmit={save}>
          <div className="scrape-config-intro">
            <div>
              <p className="card-title">Qué debe buscar el scraper</p>
              <p className="tiny muted">
                Marca cada combinación de modelo y dealer. La captación intentará completar
                la cantidad indicada; no elegirá solo las ofertas que parezcan mejores.
              </p>
            </div>
            <div className="field scrape-limit">
              <label htmlFor="scrape-limit">Resultados por combinación</label>
              <input
                id="scrape-limit"
                className="input"
                type="number"
                min={1}
                max={100}
                value={maxPerTarget}
                onChange={(event) => setMaxPerTarget(Number(event.target.value))}
              />
            </div>
          </div>

          <div className="field">
            <label htmlFor="scrape-model-search">Buscar modelo</label>
            <input
              id="scrape-model-search"
              className="input"
              type="search"
              placeholder="Audi A3, Montero…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>

          {sources.length === 0 ? (
            <Empty
              title="No hay fuentes configuradas"
              hint="Añade una fuente mediante la API antes de activar combinaciones."
            />
          ) : visibleGroups.length === 0 ? (
            <Empty title="No hay modelos que coincidan" />
          ) : (
            <div className="scrape-matrix-wrap">
              <table className="scrape-matrix">
                <thead>
                  <tr>
                    <th>Modelo</th>
                    {sources.map((source) => (
                      <th key={source.id}>
                        <span>{source.name}</span>
                        <small>{source.access}</small>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {visibleGroups.map((group) => {
                    const rowKeys = sources.map((source) => pairKey(source.id, group.key));
                    const allSelected = rowKeys.every((key) => selected.has(key));
                    return (
                      <tr key={group.key}>
                        <th scope="row">
                          <button
                            className={`scrape-model-toggle${allSelected ? " on" : ""}`}
                            type="button"
                            onClick={() => toggleRow(group)}
                            title={
                              allSelected
                                ? "Quitar este modelo de todos los dealers"
                                : "Seleccionar este modelo en todos los dealers"
                            }
                          >
                            {group.label}
                          </button>
                        </th>
                        {sources.map((source) => {
                          const key = pairKey(source.id, group.key);
                          const checked = selected.has(key);
                          return (
                            <td key={source.id}>
                              <label
                                className={`scrape-check${checked ? " on" : ""}`}
                                title={`${group.label} en ${source.name}`}
                              >
                                <input
                                  type="checkbox"
                                  checked={checked}
                                  onChange={() => toggle(source.id, group.key)}
                                />
                                <span aria-hidden="true">{checked ? "✓" : ""}</span>
                                <span className="sr-only">
                                  {group.label} en {source.name}
                                </span>
                              </label>
                            </td>
                          );
                        })}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="scrape-config-actions">
            <span className="tiny muted">{selectedCount} búsquedas por ejecución</span>
            <div className="spacer" />
            <button className="btn" type="button" onClick={onClose}>
              Cancelar
            </button>
            <button className="btn btn-primary" type="submit" disabled={saving}>
              {saving ? <span className="spinner" /> : null}
              Guardar captación
            </button>
          </div>
        </form>
      )}
    </Drawer>
  );
}

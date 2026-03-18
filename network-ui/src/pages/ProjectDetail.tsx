import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import NetworkGraph from '../components/NetworkGraph';
import Sidebar from '../components/Sidebar';
import RightSidebar from '../components/RightSidebar';
import MobileBottomNav from '../components/MobileBottomNav';
import { WelcomeModal } from '../components/WelcomeModal';
import UploadZone from '../components/UploadZone';
import CrawlForm from '../components/CrawlForm';
import SourceList from '../components/SourceList';
import { setApiContext, fetchStats, fetchTagClusters, fetchRelationships, fetchActorRelationships, fetchActorCounts } from '../api';
import type { Stats, Relationship, TagCluster } from '../types';
import { uiConfig } from '../config';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3001' : '';

export default function ProjectDetail() {
  const { id: projectId } = useParams<{ id: string }>();
  const { token, logout } = useAuth();
  const navigate = useNavigate();

  const isMobile = window.innerWidth < 1024;

  const [stats, setStats] = useState<Stats | null>(null);
  const [tagClusters, setTagClusters] = useState<TagCluster[]>([]);
  const [relationships, setRelationships] = useState<Relationship[]>([]);
  const [totalBeforeLimit, setTotalBeforeLimit] = useState<number>(0);
  const [loading, setLoading] = useState(true);
  const [selectedActor, setSelectedActor] = useState<string | null>(null);
  const [actorRelationships, setActorRelationships] = useState<Relationship[]>([]);
  const [actorTotalBeforeFilter, setActorTotalBeforeFilter] = useState<number>(0);
  const [limit, setLimit] = useState(isMobile ? uiConfig.mobileLimit : uiConfig.defaultLimit);
  const [maxHops, setMaxHops] = useState<number | null>(uiConfig.hopFilterEnabled ? 3 : null);
  const [minDensity, setMinDensity] = useState(0);
  const [enabledClusterIds, setEnabledClusterIds] = useState<Set<number>>(new Set());
  const [enabledCategories, setEnabledCategories] = useState<Set<string>>(new Set());
  const [yearRange, setYearRange] = useState<[number, number]>([uiConfig.yearRangeMin, uiConfig.yearRangeMax]);
  const [includeUndated, setIncludeUndated] = useState(uiConfig.includeUndatedDefault);
  const [keywords, setKeywords] = useState('');
  const [actorTotalCounts, setActorTotalCounts] = useState<Record<string, number>>({});
  const [showWelcome, setShowWelcome] = useState(() => !localStorage.getItem('hasSeenWelcome'));
  const [isInitialized, setIsInitialized] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [showUpload, setShowUpload] = useState(false);
  const [showCrawl, setShowCrawl] = useState(false);
  const [sourceRefreshKey, setSourceRefreshKey] = useState(0);

  // Set API context so shared api.ts functions use the right project + token
  useEffect(() => {
    setApiContext(projectId || null, token);
    return () => setApiContext(null, null);
  }, [projectId, token]);

  // Load project info
  useEffect(() => {
    fetch(`${API_BASE}/api/projects/${projectId}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => {
        if (r.status === 401) { logout(); navigate('/login'); return null; }
        return r.ok ? r.json() : null;
      })
      .then(p => { if (p) setProjectName(p.name); else navigate('/projects'); });
  }, [projectId]);

  // Initialize with tag clusters and stats
  useEffect(() => {
    const init = async () => {
      try {
        const [clusters, statsData] = await Promise.all([
          fetchTagClusters(),
          fetchStats(),
        ]);
        queueMicrotask(() => {
          setTagClusters(clusters);
          setEnabledClusterIds(new Set(clusters.map((c: TagCluster) => c.id)));
          setStats(statsData);
          setEnabledCategories(new Set(statsData.categories.map((c: any) => c.category)));
          setIsInitialized(true);
        });
      } catch (error) {
        console.error('Error initializing:', error);
      }
    };
    init();
  }, [projectId, token]);

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      const [statsData, clusters] = await Promise.all([fetchStats(), fetchTagClusters()]);
      setStats(statsData);
      const clusterIds = Array.from(enabledClusterIds);
      const categories = Array.from(enabledCategories);
      const [relRes, actorCounts] = await Promise.all([
        fetchRelationships(limit, clusterIds, categories, yearRange, includeUndated, keywords, maxHops),
        fetchActorCounts(300),
      ]);
      setRelationships(relRes.relationships);
      setTotalBeforeLimit(relRes.totalBeforeLimit);
      setActorTotalCounts(actorCounts);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  }, [isInitialized, limit, enabledClusterIds, enabledCategories, yearRange, includeUndated, keywords, maxHops]);

  // Load data when filters change
  useEffect(() => {
    if (!isInitialized) return;
    loadData();
  }, [isInitialized, limit, enabledClusterIds, enabledCategories, yearRange, includeUndated, keywords, maxHops]);

  const handleActorClick = useCallback((actorName: string) => {
    setSelectedActor(prev => prev === actorName ? null : actorName);
  }, []);

  const toggleCluster = useCallback((clusterId: number) => {
    setEnabledClusterIds(prev => {
      const next = new Set(prev);
      next.has(clusterId) ? next.delete(clusterId) : next.add(clusterId);
      return next;
    });
  }, []);

  const toggleCategory = useCallback((category: string) => {
    setEnabledCategories(prev => {
      const next = new Set(prev);
      next.has(category) ? next.delete(category) : next.add(category);
      return next;
    });
  }, []);

  const handleCloseWelcome = useCallback(() => {
    localStorage.setItem('hasSeenWelcome', 'true');
    setShowWelcome(false);
  }, []);

  // Fetch actor relationships when selected
  useEffect(() => {
    if (!selectedActor) { setActorRelationships([]); setActorTotalBeforeFilter(0); return; }
    const load = async () => {
      try {
        const clusterIds = Array.from(enabledClusterIds);
        const categories = Array.from(enabledCategories);
        const res = await fetchActorRelationships(selectedActor, clusterIds, categories, yearRange, includeUndated, keywords, maxHops);
        setActorRelationships(res.relationships);
        setActorTotalBeforeFilter(res.totalBeforeFilter);
      } catch (error) {
        console.error('Error loading actor relationships:', error);
        setActorRelationships([]); setActorTotalBeforeFilter(0);
      }
    };
    load();
  }, [selectedActor, enabledClusterIds, enabledCategories, yearRange, includeUndated, keywords, maxHops]);

  return (
    <div className="flex h-screen bg-gray-900 text-white">
      {/* Desktop Sidebar */}
      <div className="hidden lg:block">
        <Sidebar
          stats={stats}
          selectedActor={selectedActor}
          onActorSelect={setSelectedActor}
          limit={limit}
          onLimitChange={setLimit}
          maxHops={maxHops}
          onMaxHopsChange={setMaxHops}
          minDensity={minDensity}
          onMinDensityChange={setMinDensity}
          tagClusters={tagClusters}
          enabledClusterIds={enabledClusterIds}
          onToggleCluster={toggleCluster}
          enabledCategories={enabledCategories}
          onToggleCategory={toggleCategory}
          yearRange={yearRange}
          onYearRangeChange={setYearRange}
          includeUndated={includeUndated}
          onIncludeUndatedChange={setIncludeUndated}
          keywords={keywords}
          onKeywordsChange={setKeywords}
        />
      </div>

      {/* Main Graph Area */}
      <div className="flex-1 relative pb-16 lg:pb-0">
        {/* Project header bar */}
        <div className="absolute top-0 left-0 right-0 z-10 px-4 py-2 bg-gray-900/80 backdrop-blur border-b border-gray-800">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button onClick={() => navigate('/projects')} className="text-gray-400 hover:text-white text-sm">&larr; Projects</button>
              <span className="text-gray-600">|</span>
              <span className="text-sm font-medium">{projectName}</span>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setShowUpload(v => !v); setShowCrawl(false); }}
                className={`text-xs px-3 py-1 rounded transition-colors ${showUpload ? 'bg-blue-700' : 'bg-blue-600 hover:bg-blue-700'}`}
              >
                Upload
              </button>
              <button
                onClick={() => { setShowCrawl(v => !v); setShowUpload(false); }}
                className={`text-xs px-3 py-1 rounded transition-colors ${showCrawl ? 'bg-green-700' : 'bg-green-600 hover:bg-green-700'}`}
              >
                Crawl URL
              </button>
            </div>
          </div>
          {showUpload && (
            <div className="mt-2">
              <UploadZone projectId={projectId!} onComplete={loadData} />
            </div>
          )}
          {showCrawl && (
            <div className="mt-2 space-y-3">
              <CrawlForm projectId={projectId!} onComplete={() => { loadData(); setSourceRefreshKey(k => k + 1); }} />
              <SourceList projectId={projectId!} refreshKey={sourceRefreshKey} />
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center">
              <div className="animate-spin rounded-full h-16 w-16 border-t-2 border-b-2 border-blue-500 mx-auto mb-4"></div>
              <p className="text-gray-400">Loading network data...</p>
            </div>
          </div>
        ) : relationships.length === 0 ? (
          <div className="flex items-center justify-center h-full">
            <div className="text-center max-w-md px-6">
              <div className="text-6xl mb-4 opacity-30">&#x1F4C4;</div>
              <h2 className="text-xl font-semibold text-gray-300 mb-2">No data yet</h2>
              <p className="text-gray-500 mb-6">
                Upload PDFs or crawl a website to start building your knowledge graph.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={() => { setShowUpload(true); setShowCrawl(false); }}
                  className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                >
                  Upload Files
                </button>
                <button
                  onClick={() => { setShowCrawl(true); setShowUpload(false); }}
                  className="px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm rounded transition-colors"
                >
                  Crawl URL
                </button>
              </div>
            </div>
          </div>
        ) : (
          <NetworkGraph
            relationships={relationships}
            selectedActor={selectedActor}
            onActorClick={handleActorClick}
            minDensity={minDensity}
            actorTotalCounts={actorTotalCounts}
          />
        )}
      </div>

      {/* Desktop Right Sidebar */}
      {selectedActor && (
        <div className="hidden lg:block">
          <RightSidebar
            selectedActor={selectedActor}
            relationships={actorRelationships}
            totalRelationships={actorTotalBeforeFilter}
            onClose={() => setSelectedActor(null)}
            yearRange={yearRange}
          />
        </div>
      )}

      {/* Mobile Bottom Navigation */}
      <div className="lg:hidden">
        <MobileBottomNav
          stats={stats}
          selectedActor={selectedActor}
          onActorSelect={setSelectedActor}
          limit={limit}
          onLimitChange={setLimit}
          tagClusters={tagClusters}
          enabledClusterIds={enabledClusterIds}
          onToggleCluster={toggleCluster}
          enabledCategories={enabledCategories}
          onToggleCategory={toggleCategory}
          relationships={selectedActor ? actorRelationships : relationships}
        />
      </div>

      <WelcomeModal isOpen={showWelcome} onClose={handleCloseWelcome} />
    </div>
  );
}

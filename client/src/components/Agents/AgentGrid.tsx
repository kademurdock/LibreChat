import React, { useMemo, useEffect, useRef, useState } from 'react';
import { Spinner } from '@librechat/client';
import { PermissionBits } from 'librechat-data-provider';
import type t from 'librechat-data-provider';
import { useMarketplaceAgentsInfiniteQuery } from '~/data-provider/Agents';
import { useAgentCategories, useLocalize } from '~/hooks';
import { useInfiniteScroll } from '~/hooks/useInfiniteScroll';
import { useHasData } from './SmartLoader';
import ErrorDisplay from './ErrorDisplay';
import AgentCard from './AgentCard';

interface AgentGridProps {
  category: string;
  searchQuery: string;
  onSelectAgent: (agent: t.Agent) => void;
  scrollElementRef?: React.RefObject<HTMLElement>;
}

/**
 * Component for displaying a grid of agent cards
 */
const AgentGrid: React.FC<AgentGridProps> = ({
  category,
  searchQuery,
  onSelectAgent,
  scrollElementRef,
}) => {
  const localize = useLocalize();

  // Get category data from API
  const { categories } = useAgentCategories();

  // Build query parameters based on current state
  const queryParams = useMemo(() => {
    const params: {
      requiredPermission: number;
      category?: string;
      search?: string;
      limit: number;
      promoted?: 0 | 1;
    } = {
      requiredPermission: PermissionBits.VIEW, // View permission for marketplace viewing
      limit: 6,
    };

    // Handle search
    if (searchQuery) {
      params.search = searchQuery;
      // Include category filter for search if it's not 'all' or 'promoted'
      if (category !== 'all' && category !== 'promoted') {
        params.category = category;
      }
    } else {
      // Handle category-based queries
      if (category === 'promoted') {
        params.promoted = 1;
      } else if (category !== 'all') {
        params.category = category;
      }
      // For 'all' category, no additional filters needed
    }

    return params;
  }, [category, searchQuery]);

  // Use infinite query for marketplace agents
  const {
    data,
    isLoading,
    error,
    isFetching,
    fetchNextPage,
    hasNextPage,
    refetch,
    isFetchingNextPage,
  } = useMarketplaceAgentsInfiniteQuery(queryParams);

  // Flatten all pages into a single array of agents
  const currentAgents = useMemo(() => {
    if (!data?.pages) return [];
    return data.pages.flatMap((page) => page.data || []);
  }, [data?.pages]);

  // Check if we have meaningful data to prevent unnecessary loading states
  const hasData = useHasData(data?.pages?.[0]);

  // Set up infinite scroll
  const { setScrollElement } = useInfiniteScroll({
    hasNextPage,
    isLoading: isFetching || isFetchingNextPage,
    fetchNextPage: () => {
      if (hasNextPage && !isFetching) {
        fetchNextPage();
      }
    },
    threshold: 0.8, // Trigger when 80% scrolled
    throttleMs: 200,
  });

  // Connect the scroll element when it's provided
  useEffect(() => {
    const scrollElement = scrollElementRef?.current;
    if (scrollElement) {
      setScrollElement(scrollElement);
    }
  }, [scrollElementRef, setScrollElement]);

  /**
   * Get category display name from API data or use fallback
   */
  const getCategoryDisplayName = (categoryValue: string) => {
    const categoryData = categories.find((cat) => cat.value === categoryValue);
    if (categoryData) {
      return categoryData.label;
    }

    // Fallback for special categories or unknown categories
    if (categoryValue === 'promoted') {
      return localize('com_agents_top_picks');
    }
    if (categoryValue === 'all') {
      return 'All';
    }

    // Simple capitalization for unknown categories
    return categoryValue.charAt(0).toUpperCase() + categoryValue.slice(1);
  };

  /**
   * ♿ KADE (2026-07-01): announce infinite-scroll page loads to screen readers.
   * VoiceOver users had no signal that scrolling had loaded more agents — the
   * only way to find out was to keep 3-finger-swiping and re-reading the grid.
   * This effect feeds ONE polite live region below with:
   *   - the initial result count when a category/search first resolves,
   *   - "N more agents loaded" on each pagination,
   *   - "All N agents loaded" when the last page arrives.
   * Context switches (category/search change) reset silently — the grid's own
   * aria-label already describes the new context when it gets focus.
   */
  const paginationMemoRef = useRef({ key: '', count: 0 });
  const [pageAnnouncement, setPageAnnouncement] = useState('');
  useEffect(() => {
    const key = `${category}|${searchQuery}`;
    const count = currentAgents.length;
    const prev = paginationMemoRef.current;
    if (prev.key !== key) {
      // New category or search: remember the context, announce nothing yet —
      // the first data for it lands on a later run of this effect.
      paginationMemoRef.current = { key, count };
      setPageAnnouncement('');
      return;
    }
    if (count > prev.count) {
      const added = count - prev.count;
      if (prev.count === 0) {
        setPageAnnouncement(
          localize('com_agents_grid_announcement', {
            count,
            category: getCategoryDisplayName(category),
          }),
        );
      } else if (hasNextPage) {
        setPageAnnouncement(localize('com_agents_more_loaded', { added, count }));
      } else {
        setPageAnnouncement(localize('com_agents_all_loaded', { count }));
      }
    }
    paginationMemoRef.current = { key, count };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentAgents.length, category, searchQuery, hasNextPage, localize]);

  // Simple loading spinner
  const loadingSpinner = (
    <div className="flex justify-center py-12">
      <Spinner className="h-8 w-8 text-primary" />
    </div>
  );

  // Handle error state with enhanced error display
  if (error) {
    return (
      <ErrorDisplay
        error={error || 'Unknown error occurred'}
        onRetry={() => refetch()}
        context={{
          searchQuery,
          category,
        }}
      />
    );
  }

  // Main content component with proper semantic structure
  const mainContent = (
    <div
      className="space-y-6"
      role="tabpanel"
      id={`category-panel-${category}`}
      aria-labelledby={`category-tab-${category}`}
      aria-busy={isLoading && !hasData}
    >
      {/* Handle empty results with enhanced accessibility */}
      {(!currentAgents || currentAgents.length === 0) && !isLoading && !isFetching ? (
        <div
          className="py-12 text-center text-text-secondary"
          role="status"
          aria-live="polite"
          aria-label={
            searchQuery
              ? localize('com_agents_search_empty_heading')
              : localize('com_agents_empty_state_heading')
          }
        >
          <h3 className="mb-2 text-lg font-medium">{localize('com_agents_empty_state_heading')}</h3>
        </div>
      ) : (
        <>
          {/* ♿ Announcement for screen readers: initial count + pagination loads.
              Content only changes when there is genuinely something new to say
              (see the pagination effect above), so VoiceOver is not spammed. */}
          <div
            id="search-results-count"
            className="sr-only"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {pageAnnouncement}
          </div>

          {/* Agent grid - 2 per row with proper semantic structure */}
          {currentAgents && currentAgents.length > 0 && (
            <div
              className="mx-4 grid grid-cols-1 gap-6 md:grid-cols-2"
              role="grid"
              aria-label={localize('com_agents_grid_announcement', {
                count: currentAgents.length,
                category: getCategoryDisplayName(category),
              })}
            >
              {currentAgents.map((agent: t.Agent, index: number) => (
                <div key={`${agent.id}-${index}`} role="gridcell">
                  <AgentCard agent={agent} onSelect={onSelectAgent} />
                </div>
              ))}
            </div>
          )}

          {/* Loading indicator when fetching more with accessibility */}
          {isFetchingNextPage && (
            <div
              className="flex justify-center py-8"
              role="status"
              aria-live="polite"
              aria-label={localize('com_agents_loading')}
            >
              <Spinner className="h-6 w-6 text-primary" />
              <span className="sr-only">{localize('com_agents_loading')}</span>
            </div>
          )}

          {/* End of results indicator */}
          {!hasNextPage && currentAgents && currentAgents.length > 0 && (
            <div className="mt-8 text-center">
              <p className="text-sm text-text-secondary">
                {localize('com_agents_no_more_results')}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );

  if (isLoading || (isFetching && !isFetchingNextPage)) {
    return loadingSpinner;
  }
  return mainContent;
};

export default AgentGrid;

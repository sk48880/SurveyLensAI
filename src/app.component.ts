import { Component, ChangeDetectionStrategy, signal, WritableSignal, computed, inject, Signal, ViewChild, ElementRef, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { GeminiService, SurveyResponse, AnalysisResult } from './gemini.service';
import { SafeHtmlPipe } from './safe-html.pipe';
import * as d3 from 'd3';

type AppState = 'upload' | 'mapping' | 'analyzing' | 'results';
type ChatMessage = { sender: 'user' | 'bot'; text: string; };

interface TopicNode {
  name: string;
  count: number;
  responses: AnalysisResult[];
  subTopics: TopicNode[];
  expanded: boolean;
}

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, SafeHtmlPipe],
  templateUrl: './app.component.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AppComponent {
  private geminiService = inject(GeminiService);

  // App State
  appState: WritableSignal<AppState> = signal('upload');
  fileName = signal<string>('');
  error = signal<string>('');
  isParsing = signal(false);

  // CSV Data & Mappings
  rawCsvData = signal<string[][]>([]);
  headers = computed(() => this.rawCsvData()[0] || []);
  rows = computed(() => this.rawCsvData().slice(1));
  mappedTextColumn = signal<string>('');
  mappedDateColumn = signal<string>('');
  mappedDimensionColumns = signal<string[]>([]);

  // Analysis
  analysisResults: WritableSignal<AnalysisResult[]> = signal([]);
  analysisProgress = signal(0);
  isAnalyzing = signal(false);

  // Results View State
  filters = signal<{ [key: string]: string }>({});
  isModalOpen = signal(false);
  modalTitle = signal('');
  modalResponses = signal<AnalysisResult[]>([]);
  selectedTopic = signal<string | null>(null);
  
  // Chart Elements
  @ViewChild('trendChart') private trendChartEl?: ElementRef<SVGElement>;
  @ViewChild('intentChart') private intentChartEl?: ElementRef<SVGElement>;
  @ViewChild('topicChart') private topicChartEl?: ElementRef<SVGElement>;

  // Chatbot
  chatHistory: WritableSignal<ChatMessage[]> = signal([]);
  isChatbotLoading = signal(false);

  // Recommendations Agent
  recommendationFilterType = signal<'sentiment' | 'intent' | ''>('');
  recommendationFilterValue = signal('');
  generatedRecommendations = signal('');
  isGeneratingRecommendations = signal(false);
  
  // Trend Chart Options
  trendChartType = signal<'line' | 'stackedBar' | 'area'>('line');
  trendChartGroupBy = signal<'sentiment' | 'intent' | 'topics'>('sentiment');
  trendChartPeriod = signal<'day' | 'week' | 'month'>('day');

  // Date Filter
  dateFilterStart = signal<Date | null>(null);
  dateFilterEnd = signal<Date | null>(null);

  // Summary Agent
  executiveSummary = signal('');
  isGeneratingSummary = signal(false);

  // API Key validation
  isApiKeyValid = this.geminiService.isApiKeyValid;

  private delay = (ms: number) => new Promise(res => setTimeout(res, ms));
  private chartColors = ['#4f46e5', '#7c3aed', '#10b981', '#f59e0b', '#ef4444', '#db2777']; // indigo, purple, emerald, amber, red, pink

  // FIX: Moved all method definitions before computed properties and constructor to fix initialization order errors.
  private getCounts = (results: AnalysisResult[], field: 'sentiment' | 'intent' | 'topics', slice?: number) => {
    const counts: { [key: string]: number } = {};
    results.forEach(r => {
      if (!r.analysis) return;
      if (field === 'topics') {
        r.analysis.topics?.forEach(topic => {
           counts[topic] = (counts[topic] || 0) + 1;
        })
      } else {
        const value = r.analysis[field];
        if (value) {
          counts[value as string] = (counts[value as string] || 0) + 1;
        }
      }
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return slice ? sorted.slice(0, slice).reverse() : sorted;
  }
  
  private drawCharts = () => {
      if (this.trendChartEl && this.trendData()) this.drawTrendChart();
      if (this.intentChartEl) this.drawIntentPieChart();
      if (this.topicChartEl) this.drawTopicBarChart();
  }
  
  handleFileUpload = (event: Event) => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];

    if (file && file.name.endsWith('.csv')) {
      this.isParsing.set(true);
      this.fileName.set(file.name);
      this.error.set('');
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target?.result as string;
          const data = this.parseCsv(text);
          if (!data || data.length === 0 || data[0].length === 0) {
            throw new Error('The CSV file is empty or could not be parsed. Please check the file content.');
          }
          this.rawCsvData.set(data);
          this.appState.set('mapping');
        } catch (err: any) {
           console.error('Error processing CSV file:', err);
           this.error.set(err.message || 'Failed to parse the file. Please ensure it is a valid, plain-text CSV.');
           this.appState.set('upload');
        } finally {
          this.isParsing.set(false);
        }
      };
      reader.readAsText(file);
    } else {
      this.error.set('Please upload a valid .csv file.');
    }
  }

  private parseCsv = (text: string): string[][] => {
    const lines = text.split(/\r\n|\n/).filter(line => line.trim() !== '');
    if (lines.length === 0) return [];
    
    const data: string[][] = [];
    for (const line of lines) {
        const fields: string[] = [];
        let currentField = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const char = line[i];
            if (char === '"') {
                if (inQuotes && i + 1 < line.length && line[i + 1] === '"') {
                    currentField += '"';
                    i++; 
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (char === ',' && !inQuotes) {
                fields.push(currentField.trim());
                currentField = '';
            } else {
                currentField += char;
            }
        }
        fields.push(currentField.trim());
        data.push(fields);
    }
    const headerCount = data[0].length;
    if (!data.every(row => row.length === headerCount)) {
        console.warn('CSV has inconsistent column counts, which might lead to unexpected behavior.');
    }
    return data;
  }

  startAnalysis = () => {
    if (!this.mappedTextColumn()) {
      this.error.set('Please select the column for response text.');
      return;
    }
    this.error.set('');
    this.appState.set('analyzing');
    this.isAnalyzing.set(true);
    this.analysisProgress.set(0);

    const textColumnIndex = this.headers().indexOf(this.mappedTextColumn());
    const dateColumnIndex = this.mappedDateColumn() ? this.headers().indexOf(this.mappedDateColumn()) : -1;

    const dataToAnalyze = this.rows().map((row, index): SurveyResponse => {
      const response: SurveyResponse = { rowId: index + 2 };
      this.headers().forEach((header, i) => {
        response[header] = row[i];
      });
      return response;
    });
    
    this.processAnalysisQueue(dataToAnalyze, textColumnIndex, dateColumnIndex);
  }

  private processAnalysisQueue = async (queue: SurveyResponse[], textIndex: number, dateIndex: number) => {
    const totalToProcess = queue.length;
    let processedCount = 0;

    const processItem = async (item: SurveyResponse) => {
        const analysis = await this.geminiService.analyzeSurveyResponse(item[this.headers()[textIndex]]);
        const result: AnalysisResult = { ...item };
        if (analysis.error) {
            result.error = analysis.error;
        } else {
            result.analysis = analysis;
        }
        if (dateIndex > -1) {
            result.date = this.parseDate(item[this.headers()[dateIndex]]);
        }
        
        processedCount++;
        this.analysisProgress.set(Math.round((processedCount / totalToProcess) * 100));
        this.analysisResults.update(current => [...current, result]);
    };
    
    const CONCURRENCY_DELAY_MS = 1100; // ~55 requests per minute, safely under the 60 RPM limit.

    // Process items sequentially with a delay to avoid rate limiting
    for (const item of queue) {
      await processItem(item);
      await this.delay(CONCURRENCY_DELAY_MS);
    }
    
    this.isAnalyzing.set(false);
    this.appState.set('results');
}


 private parseDate = (dateStr: string): Date | undefined => {
    if (!dateStr) return undefined;
    const d = new Date(dateStr);
    if (d instanceof Date && !isNaN(d.getTime())) return d;
    
    const parts = dateStr.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
    if (parts) {
      let d2 = new Date(parseInt(parts[3]), parseInt(parts[1]) - 1, parseInt(parts[2])); // M/D/Y
      if (!isNaN(d2.getTime())) return d2;
      let d3 = new Date(parseInt(parts[3]), parseInt(parts[2]) - 1, parseInt(parts[1])); // D/M/Y
      if (!isNaN(d3.getTime())) return d3;
    }
    return undefined;
  }
  
  updateFilter = (dimension: string, event: Event) => {
    const value = (event.target as HTMLSelectElement).value;
    this.filters.update(f => ({ ...f, [dimension]: value }));
  }

  toggleDimension = (header: string) => {
    this.mappedDimensionColumns.update(dims => 
      dims.includes(header) ? dims.filter(d => d !== header) : [...dims, header]
    );
  }

  openVerbatimModal = (title: string, responses: AnalysisResult[]) => {
    this.modalTitle.set(title);
    this.modalResponses.set(responses);
    this.isModalOpen.set(true);
  }

  toggleTopicExpansion = (topicNode: TopicNode) => {
    topicNode.expanded = !topicNode.expanded;
  }

  handleChatSubmit = async (event: Event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const input = form.querySelector('input') as HTMLInputElement;
    const query = input.value.trim();
    if (!query || this.isChatbotLoading()) return;

    this.chatHistory.update(h => [...h, { sender: 'user', text: query }]);
    this.isChatbotLoading.set(true);
    input.value = '';

    try {
      const botResponse = await this.geminiService.getChatbotResponse(query, this.filteredAnalysisResults());
      this.chatHistory.update(h => [...h, { sender: 'bot', text: botResponse }]);
    } catch (e) {
      this.chatHistory.update(h => [...h, { sender: 'bot', text: 'Sorry, an error occurred.' }]);
    } finally {
      this.isChatbotLoading.set(false);
    }
  }

  onGenerateRecommendations = async () => {
    const type = this.recommendationFilterType();
    const value = this.recommendationFilterValue();
    if (!type || !value) return;

    this.isGeneratingRecommendations.set(true);
    this.generatedRecommendations.set('');

    const context = this.filteredAnalysisResults().filter(r => r.analysis && r.analysis[type] === value);
    const filterDescription = `feedback with '${value}' ${type}`;

    try {
      const response = await this.geminiService.generateRecommendations(context, filterDescription);
      this.generatedRecommendations.set(response);
    } catch (e) {
      this.generatedRecommendations.set('Sorry, an error occurred while generating recommendations.');
    } finally {
      this.isGeneratingRecommendations.set(false);
    }
  }
  
  async onGenerateSummary() {
    this.isGeneratingSummary.set(true);
    this.executiveSummary.set('');
    
    const activeFilters = this.filters();
    const filterKeys = Object.keys(activeFilters).filter(key => activeFilters[key] && activeFilters[key] !== 'all');
    let filterDescription = 'the entire dataset';
    if (filterKeys.length > 0) {
        filterDescription = filterKeys.map(k => `${k}: ${activeFilters[k]}`).join(', ');
    }

    try {
        const response = await this.geminiService.generateExecutiveSummary(this.filteredAnalysisResults(), filterDescription);
        this.executiveSummary.set(response);
    } catch (e) {
        this.executiveSummary.set('Sorry, an error occurred while generating the summary.');
    } finally {
        this.isGeneratingSummary.set(false);
    }
  }

  exportToCsv = () => {
    const results = this.filteredAnalysisResults();
    if (results.length === 0) return;

    const allHeaders = this.headers();
    const analysisHeaders = ['sentiment', 'sentiment_score', 'intent', 'emotions', 'topics', 'explanation', 'confidence', 'redacted_excerpt'];
    const headers = ['rowId', ...allHeaders, ...analysisHeaders];
    
    const csvRows = [headers.join(',')];

    const escapeCsvCell = (cell: any): string => {
        if (cell === null || cell === undefined) return '';
        let str = String(cell);
        if (Array.isArray(cell)) str = cell.join('|'); // for emotions, topics
        if (str.includes(',') || str.includes('"') || str.includes('\n')) {
            return `"${str.replace(/"/g, '""')}"`;
        }
        return str;
    };

    results.forEach(res => {
        const rowData: any[] = [res.rowId];
        allHeaders.forEach(h => rowData.push(res[h]));
        analysisHeaders.forEach(ah => rowData.push(res.analysis ? res.analysis[ah as keyof typeof res.analysis] : ''));
        csvRows.push(rowData.map(escapeCsvCell).join(','));
    });

    const csvContent = csvRows.join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', 'survey_analysis.csv');
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  resetTopicView = () => {
    this.selectedTopic.set(null);
  }
  
  updateDateFilterStart = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    this.dateFilterStart.set(value ? new Date(value + 'T00:00:00') : null);
  }

  updateDateFilterEnd = (event: Event) => {
    const value = (event.target as HTMLInputElement).value;
    this.dateFilterEnd.set(value ? new Date(value + 'T23:59:59') : null);
  }

  resetDateFilter = () => {
    this.dateFilterStart.set(null);
    this.dateFilterEnd.set(null);
  }

  resetApp = () => {
    this.appState.set('upload');
    this.fileName.set('');
    this.error.set('');
    this.rawCsvData.set([]);
    this.mappedTextColumn.set('');
    this.mappedDateColumn.set('');
    this.mappedDimensionColumns.set([]);
    this.analysisResults.set([]);
    this.analysisProgress.set(0);
    this.isAnalyzing.set(false);
    this.chatHistory.set([]);
    this.filters.set({});
    this.isParsing.set(false);
    this.generatedRecommendations.set('');
    this.isGeneratingRecommendations.set(false);
    this.recommendationFilterType.set('');
    this.recommendationFilterValue.set('');
    this.selectedTopic.set(null);
    this.dateFilterStart.set(null);
    this.dateFilterEnd.set(null);
    this.executiveSummary.set('');
    this.isGeneratingSummary.set(false);
  }
  
  private drawTrendChart = () => {
    const data = this.trendData();
    if (!data || !this.trendChartEl || data.dates.length === 0) {
        if(this.trendChartEl) d3.select(this.trendChartEl.nativeElement).selectAll('*').remove();
        return;
    };
    
    const el = this.trendChartEl.nativeElement;
    d3.select(el).selectAll('*').remove();
    const tooltip = d3.select('#tooltip');

    const margin = { top: 20, right: 30, bottom: 50, left: 40 };
    const width = el.clientWidth - margin.left - margin.right;
    const height = el.clientHeight - margin.top - margin.bottom;

    const svg = d3.select(el).append('g').attr('transform', `translate(${margin.left},${margin.top})`);
    
    const color = d3.scaleOrdinal(this.chartColors).domain(data.keys);
    const chartType = this.trendChartType();
    const axisFormat = d3.timeFormat("%d/%m/%Y");

    if (chartType === 'line' || chartType === 'area') {
        const x = d3.scaleTime().domain(d3.extent(data.dates) as [Date, Date]).range([0, width]);
        const xAxis = svg.append('g').attr('transform', `translate(0, ${height})`)
           .call(d3.axisBottom(x).tickFormat(axisFormat as any));
        xAxis.selectAll("text")
             .style("text-anchor", "end")
             .attr("dx", "-.8em")
             .attr("dy", ".15em")
             .attr("transform", "rotate(-45)")
             .style('fill', '#475569');
        xAxis.selectAll('path, line').style('stroke', '#cbd5e1');


        const yMax = d3.max(data.series, s => d3.max(s.values, d => d.value)) || 10;
        const y = d3.scaleLinear().domain([0, yMax]).range([height, 0]);
        const yAxis = svg.append('g').call(d3.axisLeft(y));
        yAxis.selectAll('path, line').style('stroke', '#cbd5e1');
        yAxis.selectAll('text').style('fill', '#475569');

        if (chartType === 'line') {
            svg.selectAll('.line')
              .data(data.series)
              .join('path')
                .attr('fill', 'none')
                .attr('stroke', d => color(d.name) as string)
                .attr('stroke-width', 2.5)
                .attr('d', d => d3.line<{date: Date, value: number}>()
                  .x(item => x(item.date))
                  .y(item => y(item.value))
                  (d.values)
                );
        } else { // area
             svg.selectAll('.area')
                .data(d3.stack().keys(data.keys)(data.stackedData as any))
                .join('path')
                .attr('fill', d => color(d.key) as string)
                .attr('fill-opacity', 0.7)
                .attr('d', d3.area()
                    .x((item: any) => x(item.data.date))
                    .y0((item: any) => y(item[0]))
                    .y1((item: any) => y(item[1])) as any
                );
        }

        const focus = svg.append("g").attr("class", "focus").style("display", "none");
        focus.append("line").attr("class", "x-hover-line").attr("y1", 0).attr("y2", height).attr('stroke', '#94a3b8').attr('stroke-width', 1).attr('stroke-dasharray', '3,3');
        
        svg.append("rect")
            .attr("width", width)
            .attr("height", height)
            .style("fill", "none")
            .style("pointer-events", "all")
            .on("mouseover", () => { focus.style("display", null); tooltip.style("display", "block"); })
            .on("mouseout", () => { focus.style("display", "none"); tooltip.style("display", "none"); })
            .on("mousemove", (event) => {
                const x0 = x.invert(d3.pointer(event)[0]);
                const bisector = d3.bisector((d: {date:Date}) => d.date).left;
                if (!data.series[0]?.values) return;
                const i = bisector(data.series[0].values, x0, 1);
                const d0 = data.series[0].values[i - 1];
                const d1 = data.series[0].values[i];
                if (!d0 || !d1) return;
                const d = (x0.getTime() - d0.date.getTime()) > (d1.date.getTime() - x0.getTime()) ? d1 : d0;
                
                focus.select(".x-hover-line").attr("transform", `translate(${x(d.date)},0)`);

                let tooltipContent = `<div class="font-bold">${d.date.toLocaleDateString()}</div>`;
                data.series.forEach(s => {
                    const point = s.values.find(p => p.date.getTime() === d.date.getTime());
                    if (point) {
                       tooltipContent += `<div><span style="color:${color(s.name)}">&#9679;</span> ${s.name}: ${point.value}</div>`;
                    }
                });
                tooltip.html(tooltipContent)
                       .style('left', (event.pageX + 15) + 'px')
                       .style('top', (event.pageY) + 'px');
            });

    } else if (chartType === 'stackedBar') {
        const stackedSeries = d3.stack().keys(data.keys).offset(d3.stackOffsetExpand)(data.stackedData as any);

        // FIX: Explicitly set the domain type to Date for the band scale to resolve TypeScript error.
        const x = d3.scaleBand<Date>()
            .domain(data.dates)
            .range([0, width])
            .padding(0.2);
        const xAxis = svg.append('g').attr('transform', `translate(0, ${height})`)
           .call(d3.axisBottom(x).tickFormat(axisFormat as any));
        xAxis.selectAll("text")
             .style("text-anchor", "end")
             .attr("dx", "-.8em")
             .attr("dy", ".15em")
             .attr("transform", "rotate(-45)")
             .style('fill', '#475569');
        xAxis.selectAll('path, line').style('stroke', '#cbd5e1');

        const y = d3.scaleLinear().domain([0, 1]).range([height, 0]);
        const yAxis = svg.append('g').call(d3.axisLeft(y).tickFormat(d3.format('.0%') as any));
        yAxis.selectAll('path, line').style('stroke', '#cbd5e1');
        yAxis.selectAll('text').style('fill', '#475569');

        svg.append('g')
            .selectAll('g')
            .data(stackedSeries)
            .join('g')
                .attr('fill', d => color(d.key))
                .selectAll('rect')
                .data(d => d)
                .join('rect')
                    .attr('x', d => x((d.data as any).date)!)
                    .attr('y', d => y(d[1]))
                    .attr('height', d => y(d[0]) - y(d[1]))
                    .attr('width', x.bandwidth())
                    .on('mouseover', (event, d) => {
                        tooltip.style('display', 'block');
                        const key = (d3.select((event.currentTarget as any).parentNode).datum() as any).key;
                        const rawCountsForDate = d.data as any;
                        const value = rawCountsForDate[key];
                        const totalForDate = data.keys.reduce((sum, k) => sum + (rawCountsForDate[k] || 0), 0);
                        const percent = totalForDate > 0 ? ((value / totalForDate) * 100).toFixed(1) : 0;

                        tooltip.html(`
                            <div class="font-bold">${rawCountsForDate.date.toLocaleDateString()}</div>
                            <div><span style="color:${color(key)}">&#9679;</span> ${key}: ${value} (${percent}%)</div>
                        `);
                    })
                    .on('mousemove', (event) => {
                        tooltip.style('left', (event.pageX + 15) + 'px')
                               .style('top', (event.pageY - 28) + 'px');
                    })
                    .on('mouseout', () => {
                        tooltip.style('display', 'none');
                    });
    }
}


  private drawIntentPieChart = () => {
    const data = this.intentCounts();
    if (!this.intentChartEl || data.length === 0) return;

    const total = data.reduce((sum, item) => sum + item[1], 0);
    
    const el = this.intentChartEl.nativeElement;
    d3.select(el).selectAll('*').remove();
    const tooltip = d3.select('#tooltip');

    const width = el.clientWidth;
    const height = el.clientHeight;
    const radius = Math.min(width, height) / 2;
    const margin = 10;

    const svg = d3.select(el)
        .append('g')
        .attr('transform', `translate(${width / 2}, ${height / 2})`);

    const color = d3.scaleOrdinal(this.chartColors);

    const pie = d3.pie<[string, number]>()
        .value(d => d[1])
        .sort(null);

    const arc = d3.arc<d3.PieArcDatum<[string, number]>>()
        .innerRadius(0)
        .outerRadius(radius - margin);
        
    const labelArc = d3.arc<d3.PieArcDatum<[string, number]>>()
        .innerRadius(radius * 0.4)
        .outerRadius(radius * 0.8);

    const arcs = svg.selectAll('.arc')
        .data(pie(data))
        .enter().append('g')
        .attr('class', 'arc');

    arcs.append('path')
        .attr('d', arc)
        .attr('fill', d => color(d.data[0]))
        .on('mouseover', function(event, d) {
            d3.select(this).attr('opacity', 0.8);
            const percent = total > 0 ? (d.data[1] / total * 100).toFixed(1) : 0;
            tooltip.style('display', 'block')
                   .html(`<strong class="capitalize">${d.data[0]}</strong>: ${d.data[1]} (${percent}%)`);
        })
        .on('mousemove', (event) => {
            tooltip.style('left', (event.pageX + 15) + 'px')
                   .style('top', (event.pageY - 28) + 'px');
        })
        .on('mouseout', function() {
            d3.select(this).attr('opacity', 1);
            tooltip.style('display', 'none');
        });

    const text = arcs.append('text')
        .attr('transform', d => `translate(${labelArc.centroid(d)})`)
        .attr('text-anchor', 'middle')
        .attr('fill', 'white')
        .attr('class', 'pointer-events-none');

    text.append('tspan')
      .attr('x', 0)
      .attr('y', '-0.5em')
      .attr('font-size', '12px')
      .attr('class', 'capitalize')
      .text(d => {
          const percent = total > 0 ? (d.data[1] / total * 100) : 0;
          return percent >= 5 ? d.data[0] : '';
      });

    text.append('tspan')
      .attr('x', 0)
      .attr('y', '0.7em')
      .attr('font-size', '11px')
      .attr('font-weight', 'bold')
      .text(d => {
          const percent = total > 0 ? (d.data[1] / total * 100) : 0;
          return percent >= 5 ? `${percent.toFixed(0)}%` : '';
      });
  }

  private drawTopicBarChart = () => {
    const data = this.topicChartData();
    if (!this.topicChartEl || data.length === 0) {
      if(this.topicChartEl) d3.select(this.topicChartEl.nativeElement).selectAll('*').remove();
      return;
    }

    const el = this.topicChartEl.nativeElement;
    d3.select(el).selectAll('*').remove();
    const tooltip = d3.select('#tooltip');

    const margin = { top: 10, right: 30, bottom: 20, left: 150 };
    const width = el.clientWidth - margin.left - margin.right;
    const height = el.clientHeight - margin.top - margin.bottom;

    const svg = d3.select(el)
      .append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    const y = d3.scaleBand()
      .range([0, height])
      .domain(data.map(d => d[0]))
      .padding(0.1);
      
    const yAxis = svg.append('g')
        .call(d3.axisLeft(y).tickSize(0));
    yAxis.select('.domain').remove();
    yAxis.selectAll('text').style('fill', '#334155');


    const xMax = d3.max(data, d => d[1]) || 0;
    const x = d3.scaleLinear()
      .domain([0, xMax])
      .range([0, width]);

    const xAxis = svg.append('g')
      .attr('transform', `translate(0, ${height})`)
      .call(d3.axisBottom(x));
    xAxis.selectAll('path, line').style('stroke', '#cbd5e1');
    xAxis.selectAll('text').style('fill', '#475569');

    svg.selectAll('.bar')
      .data(data)
      .enter()
      .append('rect')
        .attr('y', d => y(d[0])!)
        .attr('height', y.bandwidth())
        .attr('x', 0)
        .attr('width', d => x(d[1]))
        .attr('fill', this.chartColors[0])
        .style('cursor', this.selectedTopic() === null ? 'pointer' : 'default')
        .on('click', (event, d) => {
            if (this.selectedTopic() === null) {
                this.selectedTopic.set(d[0]);
            }
        })
        .on('mouseover', (event, d) => {
            tooltip.style('display', 'block')
                   .html(`<strong>${d[0]}</strong>: ${d[1]}`);
        })
        .on('mousemove', (event) => {
            tooltip.style('left', (event.pageX + 15) + 'px')
                   .style('top', (event.pageY - 28) + 'px');
        })
        .on('mouseout', () => {
            tooltip.style('display', 'none');
        });
  }

  // Computed properties
  availableDimensions = computed(() => this.headers().filter(h => h !== this.mappedTextColumn() && h !== this.mappedDateColumn()));
  
  availableFilters = computed(() => {
    const filters: { [key: string]: string[] } = {};
    const dimensions = this.mappedDimensionColumns();
    if (dimensions.length === 0) return {};

    const results = this.analysisResults();
    dimensions.forEach(dim => {
      const values = new Set<string>();
      results.forEach(r => {
        if (r[dim]) values.add(r[dim]);
      });
      filters[dim] = Array.from(values).sort();
    });
    return filters;
  });

  minDate = computed(() => {
    const dates = this.analysisResults().map(r => r.date).filter((d): d is Date => !!d);
    if (dates.length === 0) return null;
    return new Date(Math.min(...dates.map(d => d.getTime())));
  });
  
  maxDate = computed(() => {
      const dates = this.analysisResults().map(r => r.date).filter((d): d is Date => !!d);
      if (dates.length === 0) return null;
      return new Date(Math.max(...dates.map(d => d.getTime())));
  });

  dateToInputFormat = (date: Date | null): string => {
      if (!date) return '';
      return date.toISOString().split('T')[0];
  };

  filteredAnalysisResults = computed(() => {
    const results = this.analysisResults();
    const activeFilters = this.filters();
    const filterKeys = Object.keys(activeFilters).filter(key => activeFilters[key] && activeFilters[key] !== 'all');
    const startDate = this.dateFilterStart();
    const endDate = this.dateFilterEnd();

    if (filterKeys.length === 0 && !startDate && !endDate) return results;

    return results.filter(r => {
      const dimensionMatch = filterKeys.every(key => r[key] === activeFilters[key]);
      if (!dimensionMatch) return false;

      if (startDate && (!r.date || r.date < startDate)) {
        return false;
      }
      if (endDate && (!r.date || r.date > endDate)) {
        return false;
      }

      return true;
    });
  });
  
  sentimentCounts = computed(() => this.getCounts(this.filteredAnalysisResults(), 'sentiment'));
  sentimentTotal = computed(() => this.sentimentCounts().reduce((acc, curr) => acc + curr[1], 0));
  intentCounts = computed(() => this.getCounts(this.filteredAnalysisResults(), 'intent'));
  topicCounts = computed(() => {
    const counts: { [key: string]: number } = {};
    this.filteredAnalysisResults().forEach(r => {
      const mainTopic = r.analysis?.topics?.[0];
      if (mainTopic) {
        counts[mainTopic] = (counts[mainTopic] || 0) + 1;
      }
    });
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 10).reverse();
  });
  
  topicChartData = computed(() => {
    const topic = this.selectedTopic();
    if (!topic) {
        return this.topicCounts();
    }

    const subTopicCounts: { [key: string]: number } = {};
    this.filteredAnalysisResults().forEach(r => {
        if (r.analysis?.topics?.[0] === topic && r.analysis.topics.length > 1) {
            const subTopic = r.analysis.topics[1];
            subTopicCounts[subTopic] = (subTopicCounts[subTopic] || 0) + 1;
        }
    });
    const sorted = Object.entries(subTopicCounts).sort((a, b) => b[1] - a[1]);
    return sorted.slice(0, 10).reverse();
  });
  
  intentMap: Signal<Map<string, AnalysisResult[]>> = computed(() => {
    const map = new Map<string, AnalysisResult[]>();
    this.filteredAnalysisResults().forEach(r => {
      const intent = r.analysis?.intent;
      if (intent) {
        if (!map.has(intent)) {
          map.set(intent, []);
        }
        map.get(intent)!.push(r);
      }
    });
    return map;
  });

  topicTree: Signal<TopicNode[]> = computed(() => {
    const root: { [key: string]: TopicNode } = {};
    const results = this.filteredAnalysisResults();

    results.forEach(r => {
      if (!r.analysis || !r.analysis.topics || r.analysis.topics.length === 0) return;

      let currentLevel = root;
      let parentNode: TopicNode | null = null;
      
      r.analysis.topics.forEach((topicName, index) => {
        if (!currentLevel[topicName]) {
          currentLevel[topicName] = { name: topicName, count: 0, responses: [], subTopics: [], expanded: false };
           if(parentNode) {
            if (!parentNode.subTopics.some(st => st.name === topicName)) {
               parentNode.subTopics.push(currentLevel[topicName]);
            }
          }
        }
        
        const node = currentLevel[topicName];
        node.count++;
        node.responses.push(r);
        parentNode = node;
      });
    });
    
    const topLevelTopics = new Set(results.map(r => r.analysis?.topics[0]).filter(Boolean));
    return Array.from(topLevelTopics).map(topicName => root[topicName!]).filter(Boolean).sort((a,b) => b.count - a.count);
  });


  totalResponses: Signal<number> = computed(() => this.filteredAnalysisResults().length);
  
  trendData = computed(() => {
    if (!this.mappedDateColumn()) return null;
    const results = this.filteredAnalysisResults().filter((r): r is AnalysisResult & { date: Date } => !!r.date && !!r.analysis);
    if (results.length === 0) return null;

    const periodFunc = {
      day: d3.timeDay,
      week: d3.timeWeek,
      month: d3.timeMonth,
    }[this.trendChartPeriod()];

    const groupBy = this.trendChartGroupBy();

    const allKeys = Array.from(new Set(results.flatMap(r => {
        if (!r.analysis) return [];
        const value = r.analysis[groupBy as keyof typeof r.analysis];
        return Array.isArray(value) ? value : [value];
    }).filter(Boolean))) as string[];
    allKeys.sort();

    const dataByDate = d3.rollup(results,
      (v: (AnalysisResult & { date: Date })[]) => {
        const counts = new Map<string, number>();
        allKeys.forEach(key => counts.set(key, 0));
        
        v.forEach(d => {
            if (!d.analysis) return;
            const values = d.analysis[groupBy as keyof typeof d.analysis];
            if (Array.isArray(values)) {
                values.forEach(val => {
                    if (counts.has(val)) {
                        counts.set(val, counts.get(val)! + 1);
                    }
                });
            } else if (values && counts.has(values as string)) {
                counts.set(values as string, counts.get(values as string)! + 1);
            }
        });
        return counts;
      },
      d => periodFunc.floor(d.date)
    );
    
    const sortedDates = Array.from(dataByDate.keys()).sort(d3.ascending);
    
    const stackedData = sortedDates.map(date => {
        const counts = dataByDate.get(date)!;
        const entry: {[key: string]: any} = { date };
        counts.forEach((value, key) => { entry[key] = value; });
        return entry;
    });

    const series = allKeys.map(key => ({
        name: key,
        values: sortedDates.map(date => {
          const counts = dataByDate.get(date);
          const value = counts ? (counts.get(key) || 0) : 0;
          return { date, value };
        })
    }));

    return { series, dates: sortedDates, keys: allKeys, stackedData };
  });


  constructor() {
    effect(() => {
      // The effect runs if appState or any of the signals read inside change.
      this.trendChartType();
      this.trendChartGroupBy();
      this.trendChartPeriod();
      this.selectedTopic();
      
      if (this.appState() === 'results' && this.filteredAnalysisResults()) {
        setTimeout(() => this.drawCharts(), 50);
      }
    }, { allowSignalWrites: true });
  }
}